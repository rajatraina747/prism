mod download_manager;
mod engine;
mod player;
mod proc;
mod quarantine;
pub mod torrent;

use std::path::PathBuf;

use download_manager::DownloadManager;
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

// ── Structs matching frontend types ──────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSource {
    pub url: String,
    pub domain: String,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatOption {
    pub id: String,
    pub label: String,
    pub resolution: String,
    pub container: String,
    pub codec: String,
    pub file_size: u64,
    pub quality: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetadata {
    pub title: String,
    pub duration: f64,
    pub thumbnail: String,
    pub source: MediaSource,
    pub formats: Vec<FormatOption>,
    pub description: Option<String>,
    pub uploader: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistEntry {
    pub url: String,
    pub title: String,
    pub duration: f64,
    pub thumbnail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistInfo {
    pub title: String,
    pub entries: Vec<PlaylistEntry>,
}

// ── yt-dlp JSON subset ───────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct YtDlpFormat {
    format_id: Option<String>,
    format_note: Option<String>,
    ext: Option<String>,
    vcodec: Option<String>,
    acodec: Option<String>,
    height: Option<u32>,
    width: Option<u32>,
    filesize: Option<u64>,
    filesize_approx: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct YtDlpInfo {
    title: Option<String>,
    duration: Option<f64>,
    thumbnail: Option<String>,
    webpage_url: Option<String>,
    webpage_url_domain: Option<String>,
    description: Option<String>,
    uploader: Option<String>,
    formats: Option<Vec<YtDlpFormat>>,
}

#[derive(Debug, Deserialize)]
struct YtDlpPlaylistEntry {
    url: Option<String>,
    title: Option<String>,
    duration: Option<f64>,
    thumbnails: Option<Vec<YtDlpThumbnail>>,
}

#[derive(Debug, Deserialize)]
struct YtDlpThumbnail {
    url: Option<String>,
}

// ── Commands ─────────────────────────────────────────────────────────

/// Run a yt-dlp command to completion with a hard timeout, killing the child
/// if it expires. Without this a hung extractor (dead site, stuck challenge
/// solver) leaves the frontend spinner stuck forever.
/// Returns (exit_code, stdout, stderr).
pub(crate) async fn run_ytdlp_capture(
    cmd: tauri_plugin_shell::process::Command,
    timeout_secs: u64,
) -> Result<(Option<i32>, Vec<u8>, Vec<u8>), String> {
    use tauri_plugin_shell::process::CommandEvent;

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;
    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(CommandEvent::Stdout(d))) => stdout.extend_from_slice(&d),
            Ok(Some(CommandEvent::Stderr(d))) => stderr.extend_from_slice(&d),
            Ok(Some(CommandEvent::Terminated(t))) => return Ok((t.code, stdout, stderr)),
            Ok(Some(_)) => {}
            Ok(None) => return Ok((None, stdout, stderr)),
            Err(_) => {
                // The whole tree, not just the PyInstaller launcher — the
                // forked worker would otherwise outlive this timeout (the
                // same bug v1.7.3 fixed for downloads; see `proc`).
                proc::kill_tree(child.pid());
                let _ = child.kill();
                return Err(format!(
                    "yt-dlp did not respond within {} seconds — the site may be blocking or down",
                    timeout_secs
                ));
            }
        }
    }
}

#[tauri::command]
async fn parse_url(app: AppHandle, url: String) -> Result<MediaMetadata, String> {
    let mut parse_args: Vec<String> = vec![
        "--dump-json".into(),
        "--no-download".into(),
        "--no-warnings".into(),
        "--force-ipv4".into(),
    ];
    if let Some(browser) = cookies_browser(&app) {
        parse_args.push("--cookies-from-browser".into());
        parse_args.push(browser);
    }
    if let Some(proxy) = proxy_url(&app) {
        parse_args.push("--proxy".into());
        parse_args.push(proxy);
    }
    // `--` terminates options so a URL starting with `-` can't be parsed as a
    // yt-dlp flag (e.g. `--exec`). Defense-in-depth against arg injection.
    parse_args.push("--".into());
    parse_args.push(url.clone());

    let (code, stdout, stderr) =
        run_ytdlp_capture(engine::ytdlp_command(&app)?.args(&parse_args), 120).await?;

    if code != Some(0) {
        let stderr = String::from_utf8_lossy(&stderr);
        return Err(format!("yt-dlp error: {}", stderr.trim()));
    }

    let info: YtDlpInfo = serde_json::from_slice(&stdout)
        .map_err(|e| format!("Failed to parse yt-dlp output: {}", e))?;

    let domain = info
        .webpage_url_domain
        .clone()
        .unwrap_or_else(|| extract_domain(&url));

    let now = chrono::Utc::now().to_rfc3339();

    // Collect unique resolutions from real video formats (not storyboards, not audio-only)
    // Use format_note (e.g. "720p", "1080p") for labels, height for yt-dlp filters
    let raw_formats = info.formats.unwrap_or_default();

    struct ResInfo {
        label: String,  // e.g. "1080p"
        height: u32,    // actual pixel height (for yt-dlp filter)
        size: u64,
    }

    let mut resolutions: std::collections::HashMap<String, ResInfo> = std::collections::HashMap::new();

    for f in &raw_formats {
        let height = f.height.unwrap_or(0);
        if height < 144 {
            continue;
        }
        let vcodec = f.vcodec.as_deref().unwrap_or("none");
        if vcodec == "none" {
            continue;
        }
        let ext = f.ext.as_deref().unwrap_or("");
        if ext == "mhtml" {
            continue;
        }

        // Use format_note (e.g. "1080p") if available, otherwise fall back to height
        let note = f.format_note.as_deref().unwrap_or("");
        let label = if note.ends_with('p') && note.len() <= 6 {
            note.to_string()
        } else {
            format!("{}p", height)
        };

        let size = f.filesize.or(f.filesize_approx).unwrap_or(0);
        let entry = resolutions.entry(label.clone()).or_insert(ResInfo {
            label: label.clone(),
            height,
            size: 0,
        });
        if size > entry.size {
            entry.size = size;
        }
        // Keep the largest height for this label (in case of aspect ratio differences)
        if height > entry.height {
            entry.height = height;
        }
    }

    // Sort by resolution height descending
    let mut unique_formats: Vec<FormatOption> = resolutions
        .into_values()
        .map(|r| {
            let label_height: u32 = r.label.trim_end_matches('p').parse().unwrap_or(r.height);
            let quality = match label_height {
                h if h >= 2160 => "best",
                h if h >= 1080 => "high",
                h if h >= 720 => "medium",
                _ => "low",
            };
            FormatOption {
                // The chosen resolution must win over codec compatibility:
                // yt-dlp takes the FIRST satisfiable alternative, and a
                // "<=H avc1" branch is satisfiable at 1080p even when the user
                // picked 2160p (YouTube's H.264 stops at 1080p; 4K/HDR only
                // exists as VP9/AV1) — silently degrading the download. Order:
                // exact height with avc1 → exact height any codec → then the
                // <=H fallbacks for when the exact height has vanished.
                id: format!(
                    "bestvideo[height={h}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height={h}]+bestaudio/bestvideo[height<={h}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[height<={h}]+bestaudio/best[height<={h}]/best",
                    h = r.height
                ),
                label: format!("{} MP4", r.label),
                resolution: r.label.clone(),
                container: "mp4".into(),
                codec: "h264/aac".into(),
                file_size: r.size,
                quality: quality.into(),
            }
        })
        .collect();
    unique_formats.sort_by(|a, b| {
        let a_h: u32 = a.resolution.trim_end_matches('p').parse().unwrap_or(0);
        let b_h: u32 = b.resolution.trim_end_matches('p').parse().unwrap_or(0);
        b_h.cmp(&a_h)
    });

    Ok(MediaMetadata {
        title: info.title.unwrap_or_else(|| "Unknown".into()),
        duration: info.duration.unwrap_or(0.0),
        thumbnail: info.thumbnail.unwrap_or_default(),
        source: MediaSource {
            url: info.webpage_url.unwrap_or_else(|| url.clone()),
            domain,
            added_at: now,
        },
        formats: unique_formats,
        description: info.description,
        uploader: info.uploader,
    })
}

#[tauri::command]
async fn parse_playlist(app: AppHandle, url: String, limit: Option<u32>) -> Result<PlaylistInfo, String> {
    let mut playlist_args: Vec<String> = vec![
        "--flat-playlist".into(),
        "--dump-json".into(),
        "--no-download".into(),
        "--no-warnings".into(),
        "--force-ipv4".into(),
    ];
    // Subscription polls only need the newest entries, not a channel's whole
    // catalog — feeds are newest-first, so a window off the top is enough.
    if let Some(n) = limit.filter(|n| *n > 0) {
        playlist_args.push("--playlist-items".into());
        playlist_args.push(format!("1:{}", n));
    }
    if let Some(browser) = cookies_browser(&app) {
        playlist_args.push("--cookies-from-browser".into());
        playlist_args.push(browser);
    }
    if let Some(proxy) = proxy_url(&app) {
        playlist_args.push("--proxy".into());
        playlist_args.push(proxy);
    }
    playlist_args.push("--".into()); // options terminator — see parse_url
    playlist_args.push(url.clone());

    // Flat playlist dumps of large channels are slow but bounded; give the full
    // (un-limited) import path more headroom than a single-video parse.
    let timeout = if limit.is_some() { 120 } else { 600 };
    let (code, stdout, stderr) =
        run_ytdlp_capture(engine::ytdlp_command(&app)?.args(&playlist_args), timeout).await?;

    if code != Some(0) {
        let stderr = String::from_utf8_lossy(&stderr);
        return Err(format!("yt-dlp error: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&stdout);
    let lines: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();

    if lines.is_empty() {
        return Err("No playlist entries found".into());
    }

    let mut entries = Vec::new();
    let mut playlist_title = String::from("Playlist");

    for line in &lines {
        if let Ok(entry) = serde_json::from_str::<YtDlpPlaylistEntry>(line) {
            let thumb = entry.thumbnails
                .and_then(|ts| ts.into_iter().rev().find_map(|t| t.url))
                .unwrap_or_default();

            let raw_url = entry.url.unwrap_or_default();
            if raw_url.is_empty() {
                continue;
            }
            // --flat-playlist may return bare video IDs; expand to full URLs
            let entry_url = if raw_url.starts_with("http://") || raw_url.starts_with("https://") {
                raw_url
            } else {
                format!("https://www.youtube.com/watch?v={}", raw_url)
            };

            entries.push(PlaylistEntry {
                url: entry_url,
                title: entry.title.unwrap_or_else(|| "Unknown".into()),
                duration: entry.duration.unwrap_or(0.0),
                thumbnail: thumb,
            });
        }
    }

    // Try to extract playlist title from the URL
    if entries.len() > 1 {
        playlist_title = format!("Playlist ({} videos)", entries.len());
    } else if entries.len() == 1 {
        playlist_title = entries[0].title.clone();
    }

    Ok(PlaylistInfo {
        title: playlist_title,
        entries,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn start_download(
    app: AppHandle,
    id: String,
    url: String,
    output_path: String,
    format_id: Option<String>,
    audio_only: Option<bool>,
    download_subtitles: Option<bool>,
    subtitle_language: Option<String>,
    speed_limit: Option<u64>,
    expected_size: Option<u64>,
) -> Result<(), String> {
    let expanded_path = validate_download_path(&output_path, &picked_dirs(&app))?;
    // Auto-numbering against disk + other active downloads happens inside the
    // manager, atomically with reserving the template (two adds of the same
    // title must never share intermediates).
    // Ensure the parent directory exists
    if let Some(parent) = PathBuf::from(&expanded_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create download directory: {}", e))?;

        // Preflight: separate video+audio streams plus the merge temp file can
        // need ~2x the final size. Failing here beats failing at 99%.
        if let Some(size) = expected_size.filter(|s| *s > 0) {
            if let Ok(available) = fs2::available_space(parent) {
                let needed = size.saturating_mul(2);
                if available < needed {
                    return Err(format!(
                        "Not enough disk space: need ~{} MB free, have {} MB",
                        needed / 1_048_576,
                        available / 1_048_576
                    ));
                }
            }
        }
    }
    let manager = app.state::<DownloadManager>();
    manager.start_download(
        app.clone(),
        id,
        url,
        expanded_path,
        format_id,
        audio_only.unwrap_or(false),
        download_subtitles.unwrap_or(false),
        subtitle_language,
        speed_limit,
    ).await;
    Ok(())
}

#[tauri::command]
async fn cancel_download(app: AppHandle, id: String) -> Result<(), String> {
    let manager = app.state::<DownloadManager>();
    manager.cancel_download(&id).await;
    Ok(())
}

#[tauri::command]
async fn start_torrent(
    app: AppHandle,
    id: String,
    magnet: String,
    output_path: String,
    only_files: Option<Vec<usize>>,
    speed_limit: Option<u64>,
) -> Result<(), String> {
    // output_path is the destination *directory* for the torrent's files.
    let picked = picked_dirs(&app);
    let dir = validate_download_path(&output_path, &picked)?;
    let source = resolve_torrent_source(&magnet, &picked)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create download directory: {}", e))?;
    let policy = seeding_policy(&app);
    let cfg = torrent_session_config(&app);
    let manager = app.state::<torrent::TorrentManager>();
    manager.start_torrent(app.clone(), id, source, dir, policy, only_files, cfg, speed_limit);
    Ok(())
}

/// Resolve a torrent's file list without downloading — feeds the file-selection
/// modal. For magnets this fetches metadata from peers, so it can take a moment.
#[tauri::command]
async fn parse_torrent(
    app: AppHandle,
    magnet: String,
    output_path: String,
) -> Result<Vec<torrent::TorrentFileEntry>, String> {
    let picked = picked_dirs(&app);
    let dir = validate_download_path(&output_path, &picked)?;
    let source = resolve_torrent_source(&magnet, &picked)?;
    let cfg = torrent_session_config(&app);
    let manager = app.state::<torrent::TorrentManager>();
    manager.list_files(source, dir, cfg).await
}

/// `.torrent` files Prism was *launched* with (double-click / "Open with" on
/// Windows and Linux, where they arrive as plain argv rather than through the
/// deep-link plugin). The frontend reads this once at startup, like the
/// launch deep link. Only existing `.torrent` files are reported.
#[tauri::command]
fn get_launch_torrent_files() -> Vec<String> {
    std::env::args().skip(1).filter(|a| is_torrent_file_arg(a)).collect()
}

fn is_torrent_file_arg(arg: &str) -> bool {
    arg.to_ascii_lowercase().ends_with(".torrent") && std::path::Path::new(arg).is_file()
}

/// Session-wide torrent engine settings, each read through its whitelisting
/// accessor. Applied when the engine starts (next launch after a change).
fn torrent_session_config(app: &AppHandle) -> torrent::SessionConfig {
    torrent::SessionConfig {
        socks_proxy: proxy_url(app),
        blocklist_url: blocklist_url(app),
        upnp: torrent_upnp_enabled(app),
        dht: torrent_dht_enabled(app),
        trackers: extra_trackers(app),
    }
}

/// Largest `.torrent` file we'll read into memory (real ones are KBs).
const MAX_TORRENT_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// The only way webview input becomes a torrent source. Accepts a `magnet:`
/// link, an http(s) URL, or an existing `.torrent` file (as a `file://` URL
/// or a bare path) inside the allowed roots — the frontend's `isTorrentUrl`
/// deliberately lets paths through for the OS file association, so the
/// check has to live here, not there.
fn resolve_torrent_source(raw: &str, extra_roots: &[PathBuf]) -> Result<torrent::TorrentSource, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("No torrent link or file given".into());
    }
    // A Windows drive path (`C:\x.torrent`) parses as scheme "c" — treat any
    // single-letter scheme as a path, not a URL.
    if let Some(u) = url::Url::parse(s).ok().filter(|u| u.scheme().len() > 1) {
        return match u.scheme() {
            "magnet" | "http" | "https" => Ok(torrent::TorrentSource::Url(s.to_string())),
            "file" => {
                let p = u
                    .to_file_path()
                    .map_err(|_| "Invalid torrent file path".to_string())?;
                read_local_torrent(&p.to_string_lossy(), extra_roots)
            }
            other => Err(format!("Unsupported torrent source: {} links are not accepted", other)),
        };
    }
    read_local_torrent(s, extra_roots)
}

fn read_local_torrent(path: &str, extra_roots: &[PathBuf]) -> Result<torrent::TorrentSource, String> {
    let validated = validate_open_path(path, false, extra_roots)?;
    if !validated.to_ascii_lowercase().ends_with(".torrent") {
        return Err("Only .torrent files can be opened as torrents".into());
    }
    let len = std::fs::metadata(&validated)
        .map_err(|e| format!("Failed to read torrent file: {}", e))?
        .len();
    if len > MAX_TORRENT_FILE_BYTES {
        return Err("Torrent file is too large to be a valid .torrent".into());
    }
    let bytes = std::fs::read(&validated).map_err(|e| format!("Failed to read torrent file: {}", e))?;
    Ok(torrent::TorrentSource::Bytes { key: validated, bytes })
}

#[tauri::command]
async fn cancel_torrent(app: AppHandle, id: String) -> Result<(), String> {
    let manager = app.state::<torrent::TorrentManager>();
    manager.cancel_torrent(&app, &id).await;
    Ok(())
}

/// Change the downloaded-files subset of an active torrent.
#[tauri::command]
async fn update_torrent_files(app: AppHandle, id: String, only_files: Vec<usize>) -> Result<(), String> {
    let manager = app.state::<torrent::TorrentManager>();
    manager.update_file_selection(&id, only_files).await
}

/// Pause a torrent in place (no session delete, so resume needs no re-hash).
#[tauri::command]
async fn pause_torrent(app: AppHandle, id: String) -> Result<(), String> {
    let manager = app.state::<torrent::TorrentManager>();
    manager.pause_torrent(&id).await
}

#[tauri::command]
async fn resume_torrent(app: AppHandle, id: String) -> Result<(), String> {
    let manager = app.state::<torrent::TorrentManager>();
    manager.resume_torrent(&id).await
}

/// Throttle (or clear) the session-wide torrent rate limit — the same limit is
/// applied to download and upload, so it caps seeding too. Driven by Quiet Hours.
#[tauri::command]
async fn set_torrent_rate_limit(app: AppHandle, bytes_per_sec: Option<u64>) -> Result<(), String> {
    let limit = bytes_per_sec
        .filter(|b| *b > 0)
        .and_then(|b| u32::try_from(b).ok())
        .and_then(std::num::NonZeroU32::new);
    let manager = app.state::<torrent::TorrentManager>();
    manager.set_rate_limit(limit, limit).await;
    Ok(())
}

/// Validate a path the frontend asks us to open/reveal: must be an existing
/// file (not a URL or directory) inside the allowed roots (see
/// `path_is_allowed`). Defense-in-depth — the frontend only passes stored
/// download paths, but a compromised webview shouldn't be able to launch
/// arbitrary targets. `allow_dir` lets Show-in-Folder accept a directory
/// (multi-file torrents resolve to a folder); Play/open stays file-only.
pub(crate) fn validate_open_path(
    path: &str,
    allow_dir: bool,
    extra_roots: &[PathBuf],
) -> Result<String, String> {
    let expanded = expand_tilde(path);
    let p = std::path::Path::new(&expanded);
    let kind_ok = p.is_file() || (allow_dir && p.is_dir());
    if !p.is_absolute() || !kind_ok {
        return Err("File not found".into());
    }
    let resolved = p
        .canonicalize()
        .map_err(|_| "File not found".to_string())?;
    path_is_allowed(&resolved, extra_roots)?;
    Ok(expanded)
}

/// File types Prism will hand to the OS default handler ("Open"/"Play").
/// Anything else — an executable, a script, a shortcut, a disk image — is
/// refused: downloads are written by yt-dlp/librqbit without a quarantine
/// flag, and a torrent's file names are attacker-controlled, so "Open" must
/// never be a way to run what a torrent delivered. Reveal-in-folder is not
/// restricted (showing a file doesn't execute it).
const OPENABLE_EXTENSIONS: &[&str] = &[
    // video
    "mp4", "m4v", "mkv", "webm", "mov", "avi", "flv", "wmv", "mpg", "mpeg", "ts", "mts", "m2ts",
    "3gp", "ogv", "vob",
    // audio
    "mp3", "m4a", "aac", "opus", "ogg", "oga", "wav", "flac", "aiff", "aif", "wma", "alac",
    // subtitles / sidecars
    "srt", "vtt", "ass", "ssa", "sub", "lrc",
    // images (thumbnails, covers)
    "jpg", "jpeg", "png", "webp", "gif", "bmp",
    // documents commonly bundled with media
    "pdf", "txt", "nfo", "md",
];

pub(crate) fn is_openable_media(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| OPENABLE_EXTENSIONS.contains(&e.as_str()))
}

#[tauri::command]
async fn open_file(app: AppHandle, path: String) -> Result<(), String> {
    let expanded = validate_open_path(&path, false, &picked_dirs(&app))?;
    if !is_openable_media(&expanded) {
        return Err(
            "Prism only opens media, subtitle, image and text files. Use \"Show in Folder\" for anything else."
                .into(),
        );
    }
    opener::open(&expanded).map_err(|e| format!("Failed to open file: {}", e))
}

/// Open a link in the user's real browser. `target="_blank"` does nothing in
/// the webview — wry returns no new window unless the app installs a handler —
/// so every outbound link in the UI routes through here. http(s) only: the
/// webview must not be able to hand arbitrary schemes to the OS.
fn validate_external_url(url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|_| "Not a valid URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("Refusing to open a {} link", parsed.scheme()));
    }
    Ok(parsed.to_string())
}

#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    let safe = validate_external_url(&url)?;
    opener::open_browser(&safe).map_err(|e| format!("Failed to open link: {}", e))
}

#[tauri::command]
#[allow(clippy::needless_return)] // cfg-gated blocks need explicit returns
async fn show_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    let expanded = validate_open_path(&path, true, &picked_dirs(&app))?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&expanded)
            .spawn()
            .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", expanded.replace('/', "\\")))
            .spawn()
            .map_err(|e| format!("Failed to reveal in Explorer: {}", e))?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        let p = PathBuf::from(&expanded);
        let folder = p.parent().unwrap_or(&p);
        opener::open(folder).map_err(|e| format!("Failed to open folder: {}", e))
    }
}

#[tauri::command]
async fn get_default_download_path() -> Result<String, String> {
    let home = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or("Could not determine home directory")?;
    let prism_dir = home.join("Prism");
    Ok(prism_dir.to_string_lossy().into_owned())
}

#[tauri::command]
async fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Whether ffmpeg is installed. Merging video+audio streams, thumbnail/metadata
/// embedding, and SponsorBlock all silently degrade without it — the frontend
/// surfaces a warning instead of leaving users guessing.
#[tauri::command]
async fn ffmpeg_available() -> bool {
    find_ffmpeg().is_some()
}

// ── Helpers ──────────────────────────────────────────────────────────

/// Cookies-from-browser preference, whitelisted; else none.
pub fn cookies_browser(app: &AppHandle) -> Option<String> {
    read_setting(app, "cookiesFromBrowser")
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|b| matches!(b.as_str(), "safari" | "chrome" | "firefox" | "edge" | "brave"))
}

/// Read one key from the frontend's settings file. All consumers whitelist
/// the value they accept, so a corrupted settings file can't inject anything.
fn read_setting(app: &AppHandle, key: &str) -> Option<serde_json::Value> {
    let path = app.path().app_data_dir().ok()?.join("settings.json");
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get(key).cloned()
}

/// Opt-in crash reporting preference; false on any read/parse failure.
fn crash_reporting_enabled(app: &AppHandle) -> bool {
    read_setting(app, "crashReportingEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Audio-only output format, whitelisted; unknown values fall back to mp3.
pub fn audio_format(app: &AppHandle) -> String {
    read_setting(app, "audioFormat")
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|f| matches!(f.as_str(), "mp3" | "m4a" | "opus"))
        .unwrap_or_else(|| "mp3".to_string())
}

/// "Keep original container": skip the forced MP4 remux/merge so VP9/AV1
/// downloads stay in mkv/webm as yt-dlp produces them. Default off.
pub fn keep_original_container(app: &AppHandle) -> bool {
    read_setting(app, "keepOriginalContainer")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Torrent seeding policy, whitelisted; defaults to seed-to-ratio-1.0.
pub fn seeding_policy(app: &AppHandle) -> torrent::SeedingPolicy {
    match read_setting(app, "seedingPolicy")
        .and_then(|v| v.as_str().map(str::to_string))
        .as_deref()
    {
        Some("stop") => torrent::SeedingPolicy::Stop,
        Some("seed") => torrent::SeedingPolicy::Forever,
        _ => torrent::SeedingPolicy::Ratio(1.0),
    }
}

/// Upper bounds on the free-text tracker list: it comes from a user-editable
/// file and feeds the torrent engine's announce set, so cap both the number
/// of entries and each entry's length.
const MAX_EXTRA_TRACKERS: usize = 32;
const MAX_TRACKER_URL_LEN: usize = 512;

/// Extra tracker URLs from settings, announced on every torrent add (the
/// classic uTorrent "additional trackers" box). Newline- or comma-separated;
/// only well-formed http(s)/udp announce URLs pass the filter.
pub fn extra_trackers(app: &AppHandle) -> Vec<String> {
    read_setting(app, "extraTrackers")
        .and_then(|v| v.as_str().map(str::to_string))
        .map(|s| parse_extra_trackers(&s))
        .unwrap_or_default()
}

/// Pure half of `extra_trackers` (testable without an app handle).
pub(crate) fn parse_extra_trackers(raw: &str) -> Vec<String> {
    raw.split(['\n', ','])
        .map(str::trim)
        .filter(|t| !t.is_empty() && t.len() <= MAX_TRACKER_URL_LEN)
        .filter(|t| {
            url::Url::parse(t)
                .map(|u| matches!(u.scheme(), "http" | "https" | "udp") && u.host_str().is_some())
                .unwrap_or(false)
        })
        .map(str::to_string)
        .take(MAX_EXTRA_TRACKERS)
        .collect()
}

/// IP blocklist URL for the torrent session (uTorrent's ipfilter equivalent;
/// standard p2p blocklist formats, gz/zstd ok). Applied when the torrent
/// engine starts, so changes take effect on the next app launch.
/// https only: a blocklist fetched over plain http could be rewritten in
/// transit to unblock exactly the peers it was meant to block.
pub fn blocklist_url(app: &AppHandle) -> Option<String> {
    read_setting(app, "blocklistUrl")
        .and_then(|v| v.as_str().map(str::to_string))
        .and_then(|s| parse_blocklist_url(&s))
}

/// Pure half of `blocklist_url` (testable without an app handle).
pub(crate) fn parse_blocklist_url(raw: &str) -> Option<String> {
    let s = raw.trim();
    let parsed = url::Url::parse(s).ok()?;
    (parsed.scheme() == "https" && parsed.host_str().is_some()).then(|| s.to_string())
}

/// Proxy URL from settings, accepted only for known proxy schemes so a corrupted
/// settings file can't inject an arbitrary yt-dlp argument.
pub fn proxy_url(app: &AppHandle) -> Option<String> {
    read_setting(app, "proxyUrl")
        .and_then(|v| v.as_str().map(str::to_string))
        .and_then(|s| parse_proxy_url(&s))
}

/// Pure half of `proxy_url` (testable without an app handle).
pub(crate) fn parse_proxy_url(raw: &str) -> Option<String> {
    let s = raw.trim();
    let parsed = url::Url::parse(s).ok()?;
    let ok = matches!(
        parsed.scheme(),
        "http" | "https" | "socks5" | "socks5h" | "socks4"
    ) && parsed.host_str().is_some();
    ok.then(|| s.to_string())
}

/// Whether the torrent engine may open a router port via UPnP. Defaults to
/// on (inbound peers matter for swarm health) but is exposed as a setting
/// because it publishes the machine's reachability to the LAN and, when a
/// proxy is configured for privacy, defeats the point of the proxy.
pub fn torrent_upnp_enabled(app: &AppHandle) -> bool {
    read_setting(app, "torrentUpnp")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Whether the torrent engine joins the DHT. Off = tracker-only.
pub fn torrent_dht_enabled(app: &AppHandle) -> bool {
    read_setting(app, "torrentDht")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// SponsorBlock preference ("mark" | "remove"), whitelisted; else off.
pub fn sponsorblock_mode(app: &AppHandle) -> Option<String> {
    read_setting(app, "sponsorBlock")
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|m| matches!(m.as_str(), "mark" | "remove"))
}

fn expand_tilde(path: &str) -> String {
    if path.starts_with("~/") || path == "~" {
        if let Some(home) = dirs::home_dir() {
            return path.replacen('~', &home.to_string_lossy(), 1);
        }
    }
    path.to_string()
}

/// Where Prism may read and write user files: the home directory, the OS
/// Downloads directory, and any folder the user has explicitly picked in the
/// native folder dialog (`pick_download_dir` — external drives, NAS mounts,
/// a symlinked Downloads). Minus `denied_subtree`, which no download or
/// torrent file name may ever land in, whatever the destination.
fn path_is_allowed(resolved: &std::path::Path, extra_roots: &[PathBuf]) -> Result<(), String> {
    let canon = |p: &PathBuf| p.canonicalize().unwrap_or_else(|_| p.clone());
    let home = dirs::home_dir().map(|h| canon(&h));
    let mut roots: Vec<PathBuf> = Vec::new();
    roots.extend(home.clone());
    roots.extend(dirs::download_dir().map(|d| canon(&d)));
    roots.extend(extra_roots.iter().map(canon));

    if !roots.iter().any(|base| resolved.starts_with(base)) {
        return Err(
            "Path is outside your home folder. Pick the folder in Settings → Download location to allow it."
                .into(),
        );
    }
    if let Some(home) = home {
        if let Some(why) = denied_subtree(resolved, &home) {
            return Err(format!("Prism won't write or open files in {} (system/config location)", why));
        }
    }
    Ok(())
}

/// Sensitive locations under the home directory that must never receive a
/// download or be opened from the app, even though they're "inside home":
/// launch agents, shell rc files, SSH/GPG keys, browser profiles, Windows
/// Startup. Returns a short description of the matched rule.
fn denied_subtree(resolved: &std::path::Path, home: &std::path::Path) -> Option<String> {
    // Any hidden entry directly under home: ~/.ssh, ~/.config, ~/.gnupg,
    // ~/.zshrc, ~/.local/share/applications, ~/.config/autostart, ...
    if let Ok(rel) = resolved.strip_prefix(home) {
        if let Some(first) = rel.components().next() {
            let name = first.as_os_str().to_string_lossy();
            if name.starts_with('.') {
                return Some(format!("~/{}", name));
            }
        }
    }
    let denied: &[&str] = if cfg!(target_os = "macos") {
        // LaunchAgents, Preferences, Application Support, Keychains, Safari…
        &["Library"]
    } else if cfg!(target_os = "windows") {
        // Roaming/Local AppData: Start Menu\Programs\Startup lives in here.
        &["AppData"]
    } else {
        &[]
    };
    denied
        .iter()
        .find(|d| resolved.starts_with(home.join(d)))
        .map(|d| format!("~/{}", d))
}

/// Validate that a download path doesn't escape allowed directories via traversal.
pub(crate) fn validate_download_path(path: &str, extra_roots: &[PathBuf]) -> Result<String, String> {
    let expanded = expand_tilde(path);
    let path_buf = PathBuf::from(&expanded);

    if !path_buf.is_absolute() {
        return Err("Invalid download path: must be an absolute path".into());
    }

    // Reject `..` as a path component (a filename merely containing dots is fine)
    if path_buf
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("Invalid download path: directory traversal not allowed".into());
    }

    // Resolve symlinks on the deepest existing ancestor so the containment
    // check applies to the real location, not a symlink into it. The
    // not-yet-existing tail is re-appended so the deny-list sees the full
    // target (e.g. `~/Library/LaunchAgents/x` before LaunchAgents exists).
    let mut existing = path_buf.as_path();
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| "Invalid download path".to_string())?;
    }
    let resolved_existing = existing
        .canonicalize()
        .map_err(|e| format!("Invalid download path: {}", e))?;
    let tail = path_buf.strip_prefix(existing).unwrap_or(std::path::Path::new(""));
    let resolved = resolved_existing.join(tail);

    path_is_allowed(&resolved, extra_roots)
        .map_err(|e| format!("Invalid download path: {} ({})", e, expanded))?;

    Ok(expanded)
}

// ── User-picked download roots ───────────────────────────────────────

/// Folders the user chose in the native picker, so downloads can go to an
/// external drive or NAS while everything else stays confined to home.
/// Kept in Rust-managed state and persisted OUTSIDE the app-data dir (which
/// the webview can write through the fs plugin) — the webview must not be
/// able to grant itself new roots by editing a file.
pub struct PickedDirs(std::sync::Mutex<Vec<PathBuf>>);

fn picked_dirs_file() -> Option<PathBuf> {
    dirs::preference_dir().map(|d| d.join("com.prism.app.allowed-dirs.json"))
}

fn load_picked_dirs() -> Vec<PathBuf> {
    picked_dirs_file()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .collect()
}

fn save_picked_dirs(dirs: &[PathBuf]) {
    if let Some(f) = picked_dirs_file() {
        if let Some(parent) = f.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let list: Vec<String> = dirs.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        if let Ok(text) = serde_json::to_string_pretty(&list) {
            let _ = std::fs::write(f, text);
        }
    }
}

/// Snapshot of the picked roots for a validation call.
pub(crate) fn picked_dirs(app: &AppHandle) -> Vec<PathBuf> {
    app.try_state::<PickedDirs>()
        .map(|s| s.0.lock().map(|g| g.clone()).unwrap_or_default())
        .unwrap_or_default()
}

/// Native folder picker, run from Rust so the *choice itself* is the trust
/// signal: whatever the user picks (minus the deny-list) becomes an allowed
/// root for downloads and open/reveal. Returns None if cancelled.
#[tauri::command]
async fn pick_download_dir(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose where Prism saves downloads")
        .pick_folder(move |picked| {
            let _ = tx.send(picked);
        });
    let picked = match rx.await.map_err(|_| "Folder picker was closed".to_string())? {
        Some(p) => p,
        None => return Ok(None),
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("Invalid folder: {}", e))?;
    let resolved = path
        .canonicalize()
        .map_err(|e| format!("Invalid folder: {}", e))?;
    if let Some(home) = dirs::home_dir().and_then(|h| h.canonicalize().ok()) {
        if let Some(why) = denied_subtree(&resolved, &home) {
            return Err(format!(
                "Prism can't use {} as a download folder — it's a system/config location.",
                why
            ));
        }
    }
    if let Some(state) = app.try_state::<PickedDirs>() {
        let mut guard = state.0.lock().map_err(|_| "State lock poisoned".to_string())?;
        if !guard.iter().any(|d| d == &resolved) {
            guard.push(resolved.clone());
            save_picked_dirs(&guard);
        }
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn extract_domain(url: &str) -> String {
    url.split("//")
        .nth(1)
        .and_then(|s| s.split('/').next())
        .unwrap_or("unknown")
        .to_string()
}

/// Given an output path like `/path/to/video.%(ext)s`, check if a file with
/// that name already exists under any of the extensions Prism can produce
/// (video merges to .mp4, audio-only extracts to .mp3), or if another active
/// download has claimed the same template (`taken`). If so, try
/// `video (1).%(ext)s`, `video (2).%(ext)s`, etc.
///
/// The `taken` check matters as much as the disk probe: two concurrent
/// downloads of the same title would otherwise share intermediate files
/// (`video.f137.mp4` etc.) — whichever merges first deletes them out from
/// under the other, which then dies with "[Errno 2] No such file or directory".
pub(crate) fn dedupe_output_path(template: &str, taken: &[String]) -> String {
    const PROBE_EXTS: [&str; 6] = ["mp4", "mp3", "m4a", "opus", "mkv", "webm"];
    let conflicts = |tpl: &str| {
        taken.iter().any(|t| t == tpl)
            || PROBE_EXTS
                .iter()
                .any(|ext| std::path::Path::new(&tpl.replace(".%(ext)s", &format!(".{}", ext))).exists())
    };

    if !conflicts(template) {
        return template.to_string();
    }

    // Strip the .%(ext)s suffix to get the base
    let base = template.trim_end_matches(".%(ext)s");

    for n in 1..1000 {
        let candidate = format!("{} ({}).%(ext)s", base, n);
        if !conflicts(&candidate) {
            return candidate;
        }
    }
    // Unlikely fallback — just use the original
    template.to_string()
}

/// Build an augmented PATH that includes common binary directories.
/// Desktop apps launched from Finder/Dock don't inherit the shell PATH,
/// so tools installed via Homebrew, nvm, volta, etc. won't be visible.
pub fn augmented_path() -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    let mut extra: Vec<String> = Vec::new();

    // Include the app's own binary directory — bundled sidecars (deno, etc.) live here
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            extra.push(dir.to_string_lossy().into_owned());
        }
    }

    #[cfg(target_os = "macos")]
    {
        extra.push("/opt/homebrew/bin".into());
        extra.push("/usr/local/bin".into());
        if let Some(home) = dirs::home_dir() {
            // Deno
            let deno_bin = home.join(".deno/bin");
            if deno_bin.exists() {
                extra.push(deno_bin.to_string_lossy().into_owned());
            }
            // nvm-managed Node.js
            let nvm_dir = home.join(".nvm/versions/node");
            if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    if bin.exists() {
                        extra.push(bin.to_string_lossy().into_owned());
                    }
                }
            }
            // volta
            let volta_bin = home.join(".volta/bin");
            if volta_bin.exists() {
                extra.push(volta_bin.to_string_lossy().into_owned());
            }
            // fnm
            let fnm_dir = home.join(".local/share/fnm/aliases/default/bin");
            if fnm_dir.exists() {
                extra.push(fnm_dir.to_string_lossy().into_owned());
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(prog) = std::env::var("ProgramFiles") {
            extra.push(format!("{}\\nodejs", prog));
        }
        if let Some(home) = dirs::home_dir() {
            let deno_bin = home.join(".deno\\bin");
            if deno_bin.exists() {
                extra.push(deno_bin.to_string_lossy().into_owned());
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(home) = dirs::home_dir() {
            for rel in [".deno/bin", ".local/bin", ".volta/bin"] {
                let bin = home.join(rel);
                if bin.exists() {
                    extra.push(bin.to_string_lossy().into_owned());
                }
            }
        }
    }

    if extra.is_empty() {
        return base;
    }

    #[cfg(not(target_os = "windows"))]
    let sep = ":";
    #[cfg(target_os = "windows")]
    let sep = ";";

    format!("{}{}{}", extra.join(sep), sep, base)
}

/// Find ffmpeg on the system. Desktop apps may not have it in PATH,
/// so we check common locations per platform.
pub fn find_ffmpeg() -> Option<String> {
    #[cfg(target_os = "macos")]
    let candidates: &[&str] = &[
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ];
    #[cfg(target_os = "windows")]
    let candidates: &[&str] = &[
        "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
        "C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe",
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
    ];
    #[cfg(target_os = "linux")]
    let candidates: &[&str] = &[
        "/usr/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
    ];

    for p in candidates {
        if std::path::Path::new(p).exists() {
            return Some(p.to_string());
        }
    }

    // Fallback: try `which` (Unix) or `where` (Windows)
    #[cfg(not(target_os = "windows"))]
    let lookup = std::process::Command::new("which").arg("ffmpeg").output();
    #[cfg(target_os = "windows")]
    let lookup = std::process::Command::new("where").arg("ffmpeg").output();

    lookup
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").trim().to_string())
        .filter(|s| !s.is_empty())
}

// ── Crash-report scrubbing ───────────────────────────────────────────

static URL_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r#"(?i)\b(?:https?|magnet|file|ftp)://?[^\s'"<>]+"#).unwrap());
static PATH_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r#"(?:/Users/|/home/|[A-Za-z]:\\Users\\)[^\s'":<>]*"#).unwrap()
});

/// Replace anything that looks like a URL or a home-relative path with a
/// placeholder. Applied to every string a crash report could carry.
pub(crate) fn scrub_text(s: &str) -> String {
    let s = URL_RE.replace_all(s, "[url]");
    PATH_RE.replace_all(&s, "[path]").into_owned()
}

fn scrub_sentry_event(mut event: sentry::protocol::Event<'static>) -> Option<sentry::protocol::Event<'static>> {
    if let Some(m) = event.message.take() {
        event.message = Some(scrub_text(&m));
    }
    for exc in event.exception.values.iter_mut() {
        if let Some(v) = exc.value.take() {
            exc.value = Some(scrub_text(&v));
        }
    }
    for entry in event.logentry.iter_mut() {
        entry.message = scrub_text(&entry.message);
    }
    // No request/breadcrumb context for a desktop app; drop them outright.
    event.request = None;
    event.breadcrumbs.values.clear();
    Some(event)
}

// ── App setup ────────────────────────────────────────────────────────

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Menu-bar/tray icon: quick access without the window. "Paste & Download"
/// reads the clipboard and, if it holds an http(s) URL, hands it to the
/// frontend over the same channel deep links use.
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Prism", true, None::<&str>)?;
    let paste = MenuItem::with_id(app, "paste", "Paste && Download", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Prism", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &paste, &sep, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Prism")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "paste" => {
                use tauri_plugin_clipboard_manager::ClipboardExt;
                let text = app.clipboard().read_text().unwrap_or_default();
                let trimmed = text.trim();
                if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                    let _ = app.emit("quick-add-url", trimmed.to_string());
                }
                show_main_window(app);
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be first: relays argv (incl. deep links on Windows/Linux) from a
        // second launch to the running instance and refocuses its window.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A `.torrent` opened while Prism is already running reaches the
            // second instance as plain argv on Windows/Linux (macOS routes it
            // through the Opened event → deep-link plugin instead). Hand it
            // to the frontend, which validates and confirms like a deep link.
            for arg in args.iter().skip(1).filter(|a| is_torrent_file_arg(a)) {
                let _ = app.emit("open-torrent-file", arg.clone());
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .manage(DownloadManager::new())
        .manage(torrent::TorrentManager::new())
        .manage(PickedDirs(std::sync::Mutex::new(load_picked_dirs())))
        .plugin(tauri_plugin_shell::init())
        // Embedded player (separate "player" window). The plugin cleans up its
        // mpv instance on window close; macOS embeds via the window's NSView.
        .plugin(tauri_plugin_libmpv::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        // Remembers window size/position across launches.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Keep mpv's adopted video window glued to the player window on
        // resize (see player.rs module docs).
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if window.label() == "player"
                && matches!(event, tauri::WindowEvent::Resized(_))
            {
                player::refit_player_children(window);
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (window, event);
            }
        })
        .setup(|app| {
            // Release builds log too (the plugin's defaults are stdout + the
            // OS log dir). This was debug-only, which left a player or engine
            // failure on a user's machine undiagnosable: the plugin's
            // "loading libmpv from …" line and its errors went nowhere.
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;

            setup_tray(app)?;

            // Opt-in crash reporting for Rust panics. Doubly gated: the build
            // must have a DSN baked in AND the user must have enabled the
            // setting (takes effect on next launch when toggled). The init
            // guard must live as long as the app, hence managed state.
            if let Some(dsn) = option_env!("SENTRY_DSN") {
                if !dsn.is_empty() && crash_reporting_enabled(app.handle()) {
                    let guard = sentry::init((
                        dsn,
                        sentry::ClientOptions {
                            release: sentry::release_name!(),
                            // Crashes only: a panic message can embed a URL
                            // or a file path (e.g. from a format!), and the
                            // policy promises neither leaves the machine.
                            before_send: Some(std::sync::Arc::new(scrub_sentry_event)),
                            ..Default::default()
                        },
                    ));
                    app.manage(guard);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            parse_url,
            parse_playlist,
            start_download,
            cancel_download,
            start_torrent,
            cancel_torrent,
            pause_torrent,
            resume_torrent,
            update_torrent_files,
            parse_torrent,
            set_torrent_rate_limit,
            open_file,
            open_external,
            show_in_folder,
            get_default_download_path,
            get_launch_torrent_files,
            pick_download_dir,
            get_app_version,
            ffmpeg_available,
            engine::get_ytdlp_version,
            engine::update_ytdlp,
            engine::reset_ytdlp,
            player::fixup_player_video,
            player::player_available,
            player::player_init,
            player::player_destroy,
            player::player_load,
            player::player_seek,
            player::player_set,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Downloads must not outlive the app: yt-dlp's forked worker is
            // reparented to init and keeps downloading otherwise, racing the
            // next launch for the same files (see `proc`).
            if matches!(event, tauri::RunEvent::Exit) {
                let manager = app.state::<DownloadManager>();
                tauri::async_runtime::block_on(manager.kill_all());
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_domains() {
        assert_eq!(extract_domain("https://www.youtube.com/watch?v=x"), "www.youtube.com");
        assert_eq!(extract_domain("nonsense"), "unknown");
    }

    #[test]
    fn validates_paths_under_home() {
        let home = dirs::home_dir().unwrap();
        let good = home.join("Downloads/Prism/video.%(ext)s");
        assert!(validate_download_path(&good.to_string_lossy(), &[]).is_ok());
        // Tilde expansion
        assert!(validate_download_path("~/Downloads/Prism/video.%(ext)s", &[]).is_ok());
    }

    #[test]
    fn rejects_traversal_and_outside_paths() {
        assert!(validate_download_path("~/Downloads/../../etc/cron.d/x", &[]).is_err());
        assert!(validate_download_path("/etc/passwd", &[]).is_err());
        assert!(validate_download_path("relative/path.mp4", &[]).is_err());
    }

    #[test]
    fn allows_dotted_names_that_are_not_traversal() {
        let p = dirs::home_dir().unwrap().join("Downloads/my..videos/clip.%(ext)s");
        assert!(validate_download_path(&p.to_string_lossy(), &[]).is_ok());
    }

    /// Sensitive locations inside home are refused even though they're
    /// "under home" — torrent file names are untrusted, destinations are
    /// user-chosen, and none of these should ever receive a download.
    #[test]
    fn rejects_sensitive_locations_inside_home() {
        // Hidden entries directly under home, on every OS.
        assert!(validate_download_path("~/.ssh/authorized_keys", &[]).is_err());
        assert!(validate_download_path("~/.config/autostart/evil.desktop", &[]).is_err());
        assert!(validate_download_path("~/.zshrc", &[]).is_err());
        // Bare home as a directory is fine; a dotfile inside it is not.
        assert!(validate_download_path("~/Movies/clip.%(ext)s", &[]).is_ok());
        assert!(validate_download_path("~/Downloads/.hidden-but-nested/x.mp4", &[]).is_ok());
        #[cfg(target_os = "macos")]
        {
            assert!(validate_download_path("~/Library/LaunchAgents/com.evil.plist", &[]).is_err());
            assert!(validate_download_path("~/Library/Application Support/x/y.mp4", &[]).is_err());
        }
        #[cfg(target_os = "windows")]
        assert!(validate_download_path(
            "~/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/x.lnk",
            &[]
        )
        .is_err());
    }

    /// A folder the user picked in the native dialog is an allowed root even
    /// outside home (external drive, NAS) — the temp dir stands in for one.
    #[test]
    fn picked_directories_become_allowed_roots() {
        let dir = std::env::temp_dir().join(format!("prism-picked-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("clip.%(ext)s");
        let home = dirs::home_dir().unwrap().canonicalize().unwrap();
        if !dir.canonicalize().unwrap().starts_with(&home) {
            assert!(validate_download_path(&target.to_string_lossy(), &[]).is_err());
        }
        assert!(validate_download_path(&target.to_string_lossy(), std::slice::from_ref(&dir)).is_ok());
        // Files under a picked root can be opened/revealed too.
        let f = dir.join("clip.mp4");
        std::fs::write(&f, b"x").unwrap();
        assert!(validate_open_path(&f.to_string_lossy(), false, std::slice::from_ref(&dir)).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn open_path_rejects_urls_dirs_and_outside_paths() {
        assert!(validate_open_path("https://example.com/x", false, &[]).is_err());
        assert!(validate_open_path("/etc/passwd", false, &[]).is_err()); // outside allowed roots
        let home = dirs::home_dir().unwrap();
        // A directory is rejected for open (file-only) but allowed for reveal.
        assert!(validate_open_path(&home.to_string_lossy(), false, &[]).is_err());
        assert!(validate_open_path(&home.to_string_lossy(), true, &[]).is_ok());
        // A real file under home passes either way.
        let dir = home.join("Downloads");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join(format!(".prism-open-test-{}", std::process::id()));
        std::fs::write(&f, b"x").unwrap();
        assert!(validate_open_path(&f.to_string_lossy(), false, &[]).is_ok());
        assert!(validate_open_path(&f.to_string_lossy(), true, &[]).is_ok());
        std::fs::remove_file(&f).unwrap();
        // A hidden file directly under home is not openable.
        let dot = home.join(format!(".prism-dot-test-{}", std::process::id()));
        std::fs::write(&dot, b"x").unwrap();
        assert!(validate_open_path(&dot.to_string_lossy(), false, &[]).is_err());
        std::fs::remove_file(&dot).unwrap();
    }

    #[test]
    fn open_only_hands_media_to_the_os() {
        for ok in ["/x/clip.mp4", "/x/CLIP.MKV", "/x/song.opus", "/x/subs.srt", "/x/cover.jpg", "/x/readme.txt"] {
            assert!(is_openable_media(ok), "{ok} should be openable");
        }
        for bad in ["/x/setup.command", "/x/Evil.app", "/x/run.sh", "/x/x.jar", "/x/x.lnk", "/x/x.exe", "/x/x.dmg", "/x/x.scpt", "/x/noext"] {
            assert!(!is_openable_media(bad), "{bad} must not be openable");
        }
    }

    #[test]
    fn torrent_sources_are_scheme_checked() {
        assert!(matches!(
            resolve_torrent_source("magnet:?xt=urn:btih:abc", &[]),
            Ok(torrent::TorrentSource::Url(_))
        ));
        assert!(matches!(
            resolve_torrent_source("https://example.com/x.torrent", &[]),
            Ok(torrent::TorrentSource::Url(_))
        ));
        assert!(resolve_torrent_source("ftp://example.com/x.torrent", &[]).is_err());
        assert!(resolve_torrent_source("javascript:alert(1)", &[]).is_err());
        assert!(resolve_torrent_source("", &[]).is_err());
        // Local files: must exist, be inside allowed roots, and be .torrent.
        assert!(resolve_torrent_source("/etc/passwd", &[]).is_err());
        assert!(resolve_torrent_source("file:///etc/passwd", &[]).is_err());
        let dir = dirs::home_dir().unwrap().join("Downloads");
        std::fs::create_dir_all(&dir).unwrap();
        let not_torrent = dir.join(format!("prism-src-test-{}.txt", std::process::id()));
        std::fs::write(&not_torrent, b"x").unwrap();
        assert!(resolve_torrent_source(&not_torrent.to_string_lossy(), &[]).is_err());
        std::fs::remove_file(&not_torrent).unwrap();
        let t = dir.join(format!("prism-src-test-{}.torrent", std::process::id()));
        std::fs::write(&t, b"d8:announce0:e").unwrap();
        assert!(matches!(
            resolve_torrent_source(&t.to_string_lossy(), &[]),
            Ok(torrent::TorrentSource::Bytes { .. })
        ));
        std::fs::remove_file(&t).unwrap();
    }

    #[test]
    fn crash_report_text_is_scrubbed() {
        let s = scrub_text("failed https://youtube.com/watch?v=abc at /Users/me/Downloads/x.mp4 and C:\\Users\\me\\x");
        assert!(!s.contains("youtube.com"), "{s}");
        assert!(!s.contains("/Users/me"), "{s}");
        assert!(!s.contains("C:\\Users\\me"), "{s}");
        assert!(s.contains("[url]") && s.contains("[path]"), "{s}");
        assert_eq!(scrub_text("plain panic message"), "plain panic message");
    }

    #[test]
    fn external_links_are_http_only() {
        assert!(validate_external_url("https://www.rainacorp.co.uk").is_ok());
        assert!(validate_external_url("http://example.com/a?b=c#d").is_ok());
        // The webview must not be able to hand the OS anything else.
        assert!(validate_external_url("file:///etc/passwd").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("mailto:x@y.z").is_err());
        assert!(validate_external_url("prism://add?url=x").is_err());
        assert!(validate_external_url("/Users/someone/secret.txt").is_err());
        assert!(validate_external_url("not a url").is_err());
    }

    #[test]
    fn extra_trackers_are_parsed_bounded_and_scheme_checked() {
        let raw = "udp://tracker.example.org:1337/announce, https://t.example/announce\nftp://nope\nnot a url\n";
        assert_eq!(
            parse_extra_trackers(raw),
            vec![
                "udp://tracker.example.org:1337/announce".to_string(),
                "https://t.example/announce".to_string(),
            ]
        );
        // Count cap
        let many: Vec<String> = (0..100).map(|i| format!("udp://t{i}.example:1/a")).collect();
        assert_eq!(parse_extra_trackers(&many.join("\n")).len(), MAX_EXTRA_TRACKERS);
        // Length cap
        let long = format!("https://t.example/{}", "a".repeat(MAX_TRACKER_URL_LEN));
        assert!(parse_extra_trackers(&long).is_empty());
        assert!(parse_extra_trackers("").is_empty());
    }

    #[test]
    fn blocklist_requires_https() {
        assert_eq!(
            parse_blocklist_url(" https://example.com/list.p2p.gz "),
            Some("https://example.com/list.p2p.gz".into())
        );
        assert_eq!(parse_blocklist_url("http://example.com/list.p2p.gz"), None);
        assert_eq!(parse_blocklist_url("file:///etc/hosts"), None);
        assert_eq!(parse_blocklist_url(""), None);
    }

    #[test]
    fn proxy_accepts_only_proxy_schemes() {
        assert!(parse_proxy_url("socks5h://127.0.0.1:9050").is_some());
        assert!(parse_proxy_url("http://user:pass@proxy.example:3128").is_some());
        assert!(parse_proxy_url("HTTPS://proxy.example:443").is_some());
        assert_eq!(parse_proxy_url("--exec rm -rf ~"), None);
        assert_eq!(parse_proxy_url("file:///x"), None);
        assert_eq!(parse_proxy_url("socks5://"), None);
        assert_eq!(parse_proxy_url(""), None);
    }

    #[test]
    fn dedupes_existing_outputs() {
        let dir = std::env::temp_dir().join(format!("prism-dedupe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let template = dir.join("vid.%(ext)s").to_string_lossy().into_owned();
        // Nothing exists — unchanged
        assert_eq!(dedupe_output_path(&template, &[]), template);
        // vid.mp4 exists — bumps to (1)
        std::fs::write(dir.join("vid.mp4"), b"x").unwrap();
        assert_eq!(
            dedupe_output_path(&template, &[]),
            dir.join("vid (1).%(ext)s").to_string_lossy().into_owned()
        );
        // vid (1).mp3 also exists (audio-only output) — bumps to (2)
        std::fs::write(dir.join("vid (1).mp3"), b"x").unwrap();
        assert_eq!(
            dedupe_output_path(&template, &[]),
            dir.join("vid (2).%(ext)s").to_string_lossy().into_owned()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn dedupes_against_active_download_templates() {
        let dir = std::env::temp_dir().join(format!("prism-dedupe-taken-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let template = dir.join("vid.%(ext)s").to_string_lossy().into_owned();
        // Nothing on disk, but another in-flight download claimed the same
        // template — the concurrent-duplicate case that corrupted merges.
        let taken = vec![template.clone()];
        let deduped = dedupe_output_path(&template, &taken);
        assert_eq!(deduped, dir.join("vid (1).%(ext)s").to_string_lossy().into_owned());
        // A second duplicate must skip both claims.
        let taken = vec![template.clone(), deduped];
        assert_eq!(
            dedupe_output_path(&template, &taken),
            dir.join("vid (2).%(ext)s").to_string_lossy().into_owned()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Integration: the bundled yt-dlp sidecar binary actually executes.
    /// Skips (rather than fails) when the binary isn't present, e.g. on a
    /// fresh clone before sidecars are fetched.
    #[test]
    fn bundled_ytdlp_runs() {
        let triple = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            "aarch64-apple-darwin"
        } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            "x86_64-unknown-linux-gnu"
        } else {
            eprintln!("skipping: no bundled sidecar for this platform in-repo");
            return;
        };
        let bin = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("yt-dlp-{}", triple));
        if !bin.exists() {
            eprintln!("skipping: sidecar binary not present at {:?}", bin);
            return;
        }
        let out = std::process::Command::new(&bin)
            .arg("--version")
            .output()
            .expect("failed to spawn bundled yt-dlp");
        assert!(out.status.success(), "yt-dlp --version exited nonzero");
        let version = String::from_utf8_lossy(&out.stdout);
        // Versions are date-based, e.g. 2025.06.09
        assert!(
            version.trim().len() >= 8 && version.contains('.'),
            "unexpected version output: {}",
            version
        );
    }
}
