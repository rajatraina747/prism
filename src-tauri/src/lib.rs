mod download_manager;
mod engine;
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
    // `--` terminates options so a URL starting with `-` can't be parsed as a
    // yt-dlp flag (e.g. `--exec`). Defense-in-depth against arg injection.
    parse_args.push("--".into());
    parse_args.push(url.clone());

    let output = engine::ytdlp_command(&app)?
        .args(&parse_args)
        .output()
        .await
        .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

    if output.status.code() != Some(0) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("yt-dlp error: {}", stderr.trim()));
    }

    let info: YtDlpInfo = serde_json::from_slice(&output.stdout)
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
                id: format!("bestvideo[height<={}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<={}][vcodec^=avc1]/bestvideo[height<={}]+bestaudio/best[height<={}]", r.height, r.height, r.height, r.height),
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
    playlist_args.push("--".into()); // options terminator — see parse_url
    playlist_args.push(url.clone());

    let output = engine::ytdlp_command(&app)?
        .args(&playlist_args)
        .output()
        .await
        .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

    if output.status.code() != Some(0) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("yt-dlp error: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
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
    let expanded_path = validate_download_path(&output_path)?;
    // Auto-number if the target .mp4 already exists
    let deduped_path = dedupe_output_path(&expanded_path);
    // Ensure the parent directory exists
    if let Some(parent) = PathBuf::from(&deduped_path).parent() {
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
        deduped_path,
        format_id,
        audio_only.unwrap_or(false),
        download_subtitles.unwrap_or(false),
        subtitle_language,
        speed_limit,
    );
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
) -> Result<(), String> {
    // output_path is the destination *directory* for the torrent's files.
    let dir = validate_download_path(&output_path)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create download directory: {}", e))?;
    let policy = seeding_policy(&app);
    let manager = app.state::<torrent::TorrentManager>();
    manager.start_torrent(app.clone(), id, magnet, dir, policy, only_files);
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
    let dir = validate_download_path(&output_path)?;
    let manager = app.state::<torrent::TorrentManager>();
    manager.list_files(magnet, dir).await
}

#[tauri::command]
async fn cancel_torrent(app: AppHandle, id: String) -> Result<(), String> {
    let manager = app.state::<torrent::TorrentManager>();
    manager.cancel_torrent(&id).await;
    Ok(())
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
/// file (not a URL or directory) inside the same allowed roots as downloads.
/// Defense-in-depth — the frontend only passes stored download paths, but a
/// compromised webview shouldn't be able to launch arbitrary targets.
/// `allow_dir` lets Show-in-Folder accept a directory (multi-file torrents
/// resolve to a folder); Play/open stays file-only.
fn validate_open_path(path: &str, allow_dir: bool) -> Result<String, String> {
    let expanded = expand_tilde(path);
    let p = std::path::Path::new(&expanded);
    let kind_ok = p.is_file() || (allow_dir && p.is_dir());
    if !p.is_absolute() || !kind_ok {
        return Err("File not found".into());
    }
    let resolved = p
        .canonicalize()
        .map_err(|_| "File not found".to_string())?;
    let allowed = [dirs::home_dir(), dirs::download_dir(), dirs::data_dir()];
    let ok = allowed.iter().flatten().any(|base| {
        let base = base.canonicalize().unwrap_or_else(|_| base.clone());
        resolved.starts_with(&base)
    });
    if !ok {
        return Err("File is outside the allowed directories".into());
    }
    Ok(expanded)
}

#[tauri::command]
async fn open_file(path: String) -> Result<(), String> {
    let expanded = validate_open_path(&path, false)?;
    opener::open(&expanded).map_err(|e| format!("Failed to open file: {}", e))
}

#[tauri::command]
#[allow(clippy::needless_return)] // cfg-gated blocks need explicit returns
async fn show_in_folder(path: String) -> Result<(), String> {
    let expanded = validate_open_path(&path, true)?;
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

/// Validate that a download path doesn't escape allowed directories via traversal.
fn validate_download_path(path: &str) -> Result<String, String> {
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
    // check applies to the real location, not a symlink into it.
    let mut existing = path_buf.as_path();
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| "Invalid download path".to_string())?;
    }
    let resolved = existing
        .canonicalize()
        .map_err(|e| format!("Invalid download path: {}", e))?;

    // Verify path is under home, downloads, or appdata
    let allowed = [dirs::home_dir(), dirs::download_dir(), dirs::data_dir()];
    let is_allowed = allowed.iter().flatten().any(|base| {
        let base = base.canonicalize().unwrap_or_else(|_| base.clone());
        resolved.starts_with(&base)
    });

    if !is_allowed {
        return Err(format!(
            "Download path must be within your home directory: {}",
            expanded
        ));
    }

    Ok(expanded)
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
/// (video merges to .mp4, audio-only extracts to .mp3). If so, try
/// `video (1).%(ext)s`, `video (2).%(ext)s`, etc.
fn dedupe_output_path(template: &str) -> String {
    const PROBE_EXTS: [&str; 6] = ["mp4", "mp3", "m4a", "opus", "mkv", "webm"];
    let exists_any = |tpl: &str| {
        PROBE_EXTS
            .iter()
            .any(|ext| std::path::Path::new(&tpl.replace(".%(ext)s", &format!(".{}", ext))).exists())
    };

    if !exists_any(template) {
        return template.to_string();
    }

    // Strip the .%(ext)s suffix to get the base
    let base = template.trim_end_matches(".%(ext)s");

    for n in 1..1000 {
        let candidate = format!("{} ({}).%(ext)s", base, n);
        if !exists_any(&candidate) {
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
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .manage(DownloadManager::new())
        .manage(torrent::TorrentManager::new())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

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
            parse_torrent,
            set_torrent_rate_limit,
            open_file,
            show_in_folder,
            get_default_download_path,
            get_app_version,
            engine::get_ytdlp_version,
            engine::update_ytdlp,
            engine::reset_ytdlp,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
        assert!(validate_download_path(&good.to_string_lossy()).is_ok());
        // Tilde expansion
        assert!(validate_download_path("~/Downloads/Prism/video.%(ext)s").is_ok());
    }

    #[test]
    fn rejects_traversal_and_outside_paths() {
        assert!(validate_download_path("~/Downloads/../../etc/cron.d/x").is_err());
        assert!(validate_download_path("/etc/passwd").is_err());
        assert!(validate_download_path("relative/path.mp4").is_err());
    }

    #[test]
    fn allows_dotted_names_that_are_not_traversal() {
        let p = dirs::home_dir().unwrap().join("Downloads/my..videos/clip.%(ext)s");
        assert!(validate_download_path(&p.to_string_lossy()).is_ok());
    }

    #[test]
    fn open_path_rejects_urls_dirs_and_outside_paths() {
        assert!(validate_open_path("https://example.com/x", false).is_err());
        assert!(validate_open_path("/etc/passwd", false).is_err()); // outside allowed roots
        let home = dirs::home_dir().unwrap();
        // A directory is rejected for open (file-only) but allowed for reveal.
        assert!(validate_open_path(&home.to_string_lossy(), false).is_err());
        assert!(validate_open_path(&home.to_string_lossy(), true).is_ok());
        // A real file under home passes either way.
        let f = home.join(".prism-open-test");
        std::fs::write(&f, b"x").unwrap();
        assert!(validate_open_path(&f.to_string_lossy(), false).is_ok());
        assert!(validate_open_path(&f.to_string_lossy(), true).is_ok());
        std::fs::remove_file(&f).unwrap();
    }

    #[test]
    fn dedupes_existing_outputs() {
        let dir = std::env::temp_dir().join(format!("prism-dedupe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let template = dir.join("vid.%(ext)s").to_string_lossy().into_owned();
        // Nothing exists — unchanged
        assert_eq!(dedupe_output_path(&template), template);
        // vid.mp4 exists — bumps to (1)
        std::fs::write(dir.join("vid.mp4"), b"x").unwrap();
        assert_eq!(
            dedupe_output_path(&template),
            dir.join("vid (1).%(ext)s").to_string_lossy().into_owned()
        );
        // vid (1).mp3 also exists (audio-only output) — bumps to (2)
        std::fs::write(dir.join("vid (1).mp3"), b"x").unwrap();
        assert_eq!(
            dedupe_output_path(&template),
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
