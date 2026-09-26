mod app_menu;
mod client_import;
mod clip;
mod content_index;
mod convert;
mod download_manager;
mod finished;
mod formats;
mod engine;
mod errors;
mod http_engine;
mod jobs;
mod lifecycle;
mod lookup;
mod ledger;
mod migrate;
mod mpv_worker;
mod player;
mod player_state;
mod postprocess;
mod proc;
mod quarantine;
mod queue;
mod queue_rules;
mod rss;
mod shortcuts;
mod spawn;
mod store;
mod stream_server;
mod template;
mod thumbnails;
pub mod torrent;
mod watch;
mod updater;

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
    /// 30 or 60 (frame-rate class); None for formats saved before 2.3.
    #[serde(default)]
    pub fps: Option<u32>,
    #[serde(default)]
    pub hdr: bool,
    /// H.264/HEVC: plays in QuickTime and Photos too, not only VLC/IINA.
    #[serde(default = "plays_everywhere_default")]
    pub plays_everywhere: bool,
}

fn plays_everywhere_default() -> bool {
    true
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
    /// `<extractor>:<id>`: the same video however its URL is written, on any
    /// site yt-dlp supports (see `media_key`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_key: Option<String>,
    /// Several audio tracks (dubs), original first; empty when there's one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub audio_tracks: Vec<formats::AudioTrack>,
    /// Subtitles the uploader provided (not machine translations), by code.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subtitle_languages: Vec<SubtitleLanguage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleLanguage {
    pub code: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistEntry {
    pub url: String,
    pub title: String,
    pub duration: f64,
    pub thumbnail: String,
    /// yt-dlp's `live_status`: `is_upcoming` (a premiere or scheduled
    /// stream), `is_live`, … — absent for an ordinary video.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistInfo {
    pub title: String,
    pub entries: Vec<PlaylistEntry>,
    /// A YouTube channel's or playlist's own RSS feed, which answers in a
    /// fraction of a second: subscriptions poll it to see whether anything
    /// is new before running yt-dlp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feed_url: Option<String>,
}

/// The RSS feed YouTube publishes for a channel (`UC…`) or playlist id.
pub(crate) fn youtube_feed_url(playlist_id: &str) -> Option<String> {
    let id = playlist_id.trim();
    if id.len() < 10 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    Some(if id.starts_with("UC") && id.len() == 24 {
        format!("https://www.youtube.com/feeds/videos.xml?channel_id={id}")
    } else {
        format!("https://www.youtube.com/feeds/videos.xml?playlist_id={id}")
    })
}

// ── yt-dlp JSON subset ───────────────────────────────────────────────


#[derive(Debug, Deserialize)]
pub(crate) struct YtDlpInfo {
    title: Option<String>,
    duration: Option<f64>,
    thumbnail: Option<String>,
    webpage_url: Option<String>,
    webpage_url_domain: Option<String>,
    description: Option<String>,
    uploader: Option<String>,
    formats: Option<Vec<formats::YtDlpFormat>>,
    #[serde(default)]
    subtitles: Option<std::collections::BTreeMap<String, Vec<YtDlpSubtitle>>>,
    id: Option<String>,
    extractor_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct YtDlpSubtitle {
    name: Option<String>,
}

/// A key for "the same video" that doesn't depend on how its URL was written:
/// yt-dlp's extractor plus that site's own id. URL-level dedupe (`sourceKey`
/// in the frontend) only knows YouTube and magnets; this covers every site.
///
/// Not for yt-dlp's `Generic` extractor: there the id is just the file name
/// (`video` for any `…/video.mp4`), so unrelated files on different sites
/// would share a key. Those keep the URL-level check.
pub(crate) fn media_key(extractor_key: Option<&str>, id: Option<&str>) -> Option<String> {
    let extractor = extractor_key
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("generic"))?;
    let id = id.map(str::trim).filter(|s| !s.is_empty())?;
    Some(format!("{}:{}", extractor.to_ascii_lowercase(), id))
}

#[derive(Debug, Deserialize)]
pub(crate) struct YtDlpPlaylistEntry {
    pub(crate) url: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) duration: Option<f64>,
    pub(crate) thumbnails: Option<Vec<YtDlpThumbnail>>,
    /// yt-dlp's extractor for the entry (`Youtube`) and the site's own id:
    /// together they rebuild a URL when a flat entry carries only the id.
    #[serde(default)]
    pub(crate) ie_key: Option<String>,
    #[serde(default)]
    pub(crate) id: Option<String>,
    #[serde(default)]
    pub(crate) webpage_url: Option<String>,
    #[serde(default)]
    pub(crate) live_status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct YtDlpThumbnail {
    pub(crate) url: Option<String>,
}

// ── Commands ─────────────────────────────────────────────────────────

/// Metadata lookups (parse, playlist, `--version`) allowed to run at once.
/// The frontend never needs more; the cap is what stops a burst of IPC calls
/// from forking an unbounded number of yt-dlp processes (S-8).
const MAX_CONCURRENT_CAPTURES: usize = 6;
/// How long a lookup waits for a free slot before giving up.
const CAPTURE_SLOT_WAIT: std::time::Duration = std::time::Duration::from_secs(60);
/// A flat dump of a very large channel is tens of MB; past this it is not
/// output worth holding in memory.
const MAX_CAPTURE_STDOUT: usize = 64 * 1024 * 1024;
/// Only the tail of stderr matters (the error is at the end).
const MAX_CAPTURE_STDERR: usize = 256 * 1024;

static CAPTURE_SLOTS: std::sync::LazyLock<tokio::sync::Semaphore> =
    std::sync::LazyLock::new(|| tokio::sync::Semaphore::new(MAX_CONCURRENT_CAPTURES));

/// Kill a capture's whole run, not just the PyInstaller launcher — the forked
/// worker would otherwise outlive it (see `spawn` and `proc`).
fn kill_capture(child: spawn::Child) {
    child.kill();
}

/// Append to a buffer that keeps only its last `cap` bytes.
fn push_tail(buf: &mut Vec<u8>, data: &[u8], cap: usize) {
    buf.extend_from_slice(data);
    if buf.len() > cap {
        buf.drain(..buf.len() - cap);
    }
}

/// Run a yt-dlp command to completion with a hard timeout, killing the child
/// if it expires. Without this a hung extractor (dead site, stuck challenge
/// solver) leaves the frontend spinner stuck forever. Bounded in concurrency
/// and in how much output it buffers.
/// Returns (exit_code, stdout, stderr).
pub(crate) async fn run_ytdlp_capture(
    cmd: spawn::CommandSpec,
    timeout_secs: u64,
) -> Result<(Option<i32>, Vec<u8>, Vec<u8>), errors::PrismError> {
    use errors::{ErrorCode, PrismError};
    use spawn::Event;

    let _slot = tokio::time::timeout(CAPTURE_SLOT_WAIT, CAPTURE_SLOTS.acquire())
        .await
        .map_err(|_| {
            log::warn!("no free yt-dlp lookup slot after {}s", CAPTURE_SLOT_WAIT.as_secs());
            PrismError::new(ErrorCode::Busy, "Prism is busy with other link lookups — try again in a moment")
        })?
        .map_err(|_| PrismError::new(ErrorCode::Cancelled, "yt-dlp lookups are shutting down"))?;

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| PrismError::new(ErrorCode::EngineMissing, format!("Failed to run yt-dlp: {}", e)))?;
    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(Event::Stdout(d))) => {
                if stdout.len().saturating_add(d.len()) > MAX_CAPTURE_STDOUT {
                    log::warn!("yt-dlp lookup output passed {} bytes; killed", MAX_CAPTURE_STDOUT);
                    kill_capture(child);
                    return Err(PrismError::new(
                        ErrorCode::Unknown,
                        format!("yt-dlp returned more than {} MB of data — stopped", MAX_CAPTURE_STDOUT / 1_048_576),
                    ));
                }
                stdout.extend_from_slice(&d);
            }
            Ok(Some(Event::Stderr(d))) => push_tail(&mut stderr, &d, MAX_CAPTURE_STDERR),
            Ok(Some(Event::Terminated(code))) => return Ok((code, stdout, stderr)),
            Ok(None) => return Ok((None, stdout, stderr)),
            Err(_) => {
                log::warn!("yt-dlp lookup timed out after {timeout_secs}s; killed");
                kill_capture(child);
                return Err(PrismError::new(
                    ErrorCode::Timeout,
                    format!("yt-dlp did not respond within {timeout_secs} seconds — the site may be blocking or down"),
                ));
            }
        }
    }
}

/// The network flags every lookup shares: address family, browser cookies
/// and proxy, each already whitelisted by its accessor.
pub(crate) fn lookup_network_args(app: &AppHandle) -> Vec<String> {
    let mut args = Vec::new();
    if force_ipv4(app) {
        args.push("--force-ipv4".into());
    }
    if let Some(browser) = cookies_browser(app) {
        args.push("--cookies-from-browser".into());
        args.push(browser);
    }
    if let Some(proxy) = proxy_url(app) {
        args.push("--proxy".into());
        args.push(proxy);
    }
    args
}

/// The yt-dlp command for a lookup; a missing engine is its own error code.
fn lookup_command(app: &AppHandle) -> Result<spawn::CommandSpec, errors::PrismError> {
    engine::ytdlp_command(app).map_err(|e| errors::PrismError::new(errors::ErrorCode::EngineMissing, e))
}

#[tauri::command]
async fn parse_url(app: AppHandle, url: String) -> Result<MediaMetadata, errors::PrismError> {
    let mut parse_args: Vec<String> = vec![
        "--dump-json".into(),
        "--no-download".into(),
        "--no-warnings".into(),
    ];
    parse_args.extend(lookup_network_args(&app));
    // `--` terminates options so a URL starting with `-` can't be parsed as a
    // yt-dlp flag (e.g. `--exec`). Defense-in-depth against arg injection.
    parse_args.push("--".into());
    parse_args.push(url.clone());

    let (code, stdout, stderr) =
        run_ytdlp_capture(lookup_command(&app)?.args(&parse_args), 120).await?;

    if code != Some(0) {
        let stderr = String::from_utf8_lossy(&stderr);
        log::warn!(
            "link lookup on {} failed: {}",
            extract_domain(&url),
            stderr.trim().lines().last().unwrap_or("no output")
        );
        return Err(errors::classify_output(&stderr));
    }

    let info: YtDlpInfo = serde_json::from_slice(&stdout)
        .map_err(|e| format!("Failed to parse yt-dlp output: {}", e))?;
    Ok(metadata_from_info(info, &url, keep_original_container(&app)))
}

/// The details dialog's view of one video from yt-dlp's JSON: title, source
/// and the resolutions on offer.
pub(crate) fn metadata_from_info(info: YtDlpInfo, url: &str, keep_container: bool) -> MediaMetadata {
    let domain = info
        .webpage_url_domain
        .clone()
        .unwrap_or_else(|| extract_domain(url));

    let now = chrono::Utc::now().to_rfc3339();

    let raw_formats = info.formats.unwrap_or_default();
    let unique_formats = formats::options(&raw_formats, keep_container);
    let audio_tracks = formats::audio_tracks(&raw_formats);
    let subtitle_languages = info
        .subtitles
        .unwrap_or_default()
        .into_iter()
        .filter(|(code, _)| formats::valid_language(code) && code != "live_chat")
        .map(|(code, subs)| {
            let name = subs.into_iter().find_map(|s| s.name).unwrap_or_else(|| code.clone());
            SubtitleLanguage { code, name }
        })
        .collect();

    MediaMetadata {
        title: info.title.unwrap_or_else(|| "Unknown".into()),
        duration: info.duration.unwrap_or(0.0),
        thumbnail: info.thumbnail.unwrap_or_default(),
        source: MediaSource {
            url: info.webpage_url.unwrap_or_else(|| url.to_string()),
            domain,
            added_at: now,
        },
        formats: unique_formats,
        description: info.description,
        uploader: info.uploader,
        media_key: media_key(info.extractor_key.as_deref(), info.id.as_deref()),
        audio_tracks,
        subtitle_languages,
    }
}

#[tauri::command]
async fn parse_playlist(app: AppHandle, url: String, limit: Option<u32>) -> Result<PlaylistInfo, errors::PrismError> {
    let mut playlist_args: Vec<String> = vec![
        "--flat-playlist".into(),
        "--dump-json".into(),
        "--no-download".into(),
        "--no-warnings".into(),
    ];
    // Subscription polls only need the newest entries, not a channel's whole
    // catalog — feeds are newest-first, so a window off the top is enough.
    if let Some(n) = limit.filter(|n| *n > 0) {
        playlist_args.push("--playlist-items".into());
        playlist_args.push(format!("1:{}", n));
    }
    playlist_args.extend(lookup_network_args(&app));
    playlist_args.push("--".into()); // options terminator — see parse_url
    playlist_args.push(url.clone());

    // Flat playlist dumps of large channels are slow but bounded; give the full
    // (un-limited) import path more headroom than a single-video parse.
    let timeout = if limit.is_some() { 120 } else { 600 };
    let (code, stdout, stderr) =
        run_ytdlp_capture(lookup_command(&app)?.args(&playlist_args), timeout).await?;

    if code != Some(0) {
        let stderr = String::from_utf8_lossy(&stderr);
        log::warn!(
            "link lookup on {} failed: {}",
            extract_domain(&url),
            stderr.trim().lines().last().unwrap_or("no output")
        );
        return Err(errors::classify_output(&stderr));
    }

    let stdout = String::from_utf8_lossy(&stdout);
    let lines: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();

    if lines.is_empty() {
        return Err("No playlist entries found".into());
    }

    Ok(playlist_from_lines(&lines))
}

/// A flat `--dump-json` list (one entry per line) as the subscription code
/// reads it. Entries keep their own site's URLs (`lookup::entry_url`), and the
/// title is the list's own, which yt-dlp repeats on every line.
fn playlist_from_lines(lines: &[&str]) -> PlaylistInfo {
    let mut title: Option<String> = None;
    let mut feed_url: Option<String> = None;
    let mut entries = Vec::new();
    for line in lines {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if feed_url.is_none() && value.get("ie_key").and_then(|k| k.as_str()) == Some("Youtube") {
            feed_url = value.get("playlist_id").and_then(|p| p.as_str()).and_then(youtube_feed_url);
        }
        if title.is_none() {
            title = ["playlist_title", "playlist"]
                .iter()
                .find_map(|k| value.get(*k).and_then(|t| t.as_str()))
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_string);
        }
        if let Some(entry) = serde_json::from_value::<YtDlpPlaylistEntry>(value).ok().and_then(lookup::playlist_entry) {
            entries.push(entry);
        }
    }
    let title = title.unwrap_or_else(|| match entries.as_slice() {
        [only] => only.title.clone(),
        _ => format!("Playlist ({} videos)", entries.len()),
    });
    PlaylistInfo { title, entries, feed_url }
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
    output_dir: Option<String>,
    filename_template: Option<String>,
    template_vars: Option<template::TemplateVars>,
    clip_start: Option<String>,
    clip_end: Option<String>,
    split_chapters: Option<bool>,
    // False for a subscription entry on another site (REVIEW 2026-09-26 M1).
    // Absent (older items) = the cookies setting decides, as before.
    use_cookies: Option<bool>,
    // A dub other than the original (YouTube's audio tracks); None = original.
    audio_language: Option<String>,
    // Put the subtitles inside the video file rather than beside it.
    embed_subtitles: Option<bool>,
    // Subscription items: consult and update yt-dlp's download archive.
    use_archive: Option<bool>,
    // The page the link came from (embedded players often require it).
    referer: Option<String>,
) -> Result<(), String> {
    let referer = referer.as_deref().and_then(http_engine::valid_referer);
    // Both end up inside yt-dlp arguments: codes only, nothing else.
    let audio_language = audio_language.filter(|l| !l.is_empty());
    if audio_language.as_deref().is_some_and(|l| !formats::valid_language(l)) {
        return Err("Unknown audio language".into());
    }
    if subtitle_language.as_deref().is_some_and(|l| !l.split(',').all(formats::valid_language)) {
        return Err("Unknown subtitle language".into());
    }
    // Validated here rather than deeper in: a bad range should be refused
    // before anything is spawned, with a message the user can act on.
    let clip_section = match (clip_start.as_deref(), clip_end.as_deref()) {
        (None, None) => None,
        (start, end) => Some(clip::section_arg(start, end)?),
    };
    // Items queued with a file name template are named here, by the same code
    // Settings previews; older items arrive with a finished output path.
    let output_path = match (output_dir, filename_template) {
        (Some(dir), Some(tpl)) if !tpl.trim().is_empty() => {
            templated_output_path(&dir, &tpl, &template_vars.unwrap_or_default())?
        }
        _ => output_path,
    };
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
                // Less what a paused run's partial files already hold: a
                // resume only needs room for the rest (REVIEW 2026-09-26).
                let needed = size.saturating_mul(2).saturating_sub(partial_bytes(&output_path));
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
        clip_section,
        split_chapters.unwrap_or(false),
        use_cookies.unwrap_or(true),
        download_manager::Extras {
            audio_language,
            embed_subtitles: embed_subtitles.unwrap_or(false),
            referer,
            archive: use_archive
                .unwrap_or(false)
                .then(|| app.path().app_data_dir().ok().map(|d| d.join("archive.txt")))
                .flatten(),
        },
    ).await;
    Ok(())
}

/// Bytes already downloaded for the yt-dlp template `template`: the `.part`
/// files (and HLS/DASH `.part-Frag` pieces) beside it that share its name.
fn partial_bytes(template: &str) -> u64 {
    let base = download_manager::template_file(template, "");
    let base = base.strip_suffix('.').unwrap_or(&base);
    let base = std::path::Path::new(base);
    let (Some(dir), Some(prefix)) = (base.parent(), base.file_name().map(|n| n.to_string_lossy().into_owned())) else {
        return 0;
    };
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.starts_with(&prefix) && (name.ends_with(".part") || name.contains(".part-Frag"))
        })
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

/// yt-dlp's `-o` template for `dir`, named by a file name template: its
/// subfolders kept, `%` escaped (yt-dlp would expand it), `.%(ext)s` appended.
fn templated_output_path(dir: &str, template: &str, vars: &template::TemplateVars) -> Result<String, String> {
    let rel = template::render(template, vars).map_err(|e| format!("File name template: {e}"))?;
    let rel = rel.to_string_lossy().replace('\\', "/").replace('%', "%%");
    // The folder too: a `100% Music` destination broke every download (B-10).
    Ok(format!("{}/{rel}.%(ext)s", dir.trim_end_matches(['/', '\\']).replace('%', "%%")))
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
    let cfg = torrent_session_config(&app);
    let source = with_cached_metadata(
        resolve_torrent_source(&magnet, &picked)?,
        cfg.torrent_cache_dir.as_deref(),
    );
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create download directory: {}", e))?;
    let policy = seeding_policy(&app);
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
    let cfg = torrent_session_config(&app);
    let source = with_cached_metadata(
        resolve_torrent_source(&magnet, &picked)?,
        cfg.torrent_cache_dir.as_deref(),
    );
    let manager = app.state::<torrent::TorrentManager>();
    manager.list_files(&app, source, dir, cfg).await
}

/// "Update tracker": fresh announce to trackers + DHT + LSD, keeping progress.
#[tauri::command]
async fn reannounce_torrent(app: AppHandle, id: String) -> Result<(), String> {
    app.state::<torrent::TorrentManager>().reannounce_torrent(&id).await
}

/// "Force re-check": hash every piece on disk again.
#[tauri::command]
async fn recheck_torrent(app: AppHandle, id: String) -> Result<(), String> {
    app.state::<torrent::TorrentManager>().recheck_torrent(&id).await
}

#[tauri::command]
async fn torrent_peers(app: AppHandle, id: String) -> Result<Vec<torrent::PeerRow>, String> {
    app.state::<torrent::TorrentManager>().peers(&id).await
}

#[tauri::command]
async fn torrent_details(app: AppHandle, id: String) -> Result<torrent::TorrentDetails, String> {
    app.state::<torrent::TorrentManager>().details(&id).await
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
    let app_data = app.path().app_data_dir().ok();
    torrent::SessionConfig {
        socks_proxy: proxy_url(app),
        blocklist_url: blocklist_url(app),
        // UPnP opens a port on the router for inbound peers, which reach the
        // machine directly: with a proxy set it would undo the proxy (M6).
        upnp: torrent_upnp_enabled(app) && proxy_url(app).is_none(),
        dht: torrent_dht_enabled(app),
        utp: setting_bool(app, "torrentUtp", false),
        lsd: setting_bool(app, "torrentLsd", true),
        listen_port: setting_u64(app, "torrentListenPort", torrent::DEFAULT_LISTEN_PORT as u64, 1024, 65535) as u16,
        peer_limit: match setting_u64(app, "torrentPeerLimit", 0, 0, 10_000) {
            0 => None,
            n => Some(n as usize),
        },
        trackers: extra_trackers(app),
        persistence_dir: app_data.as_ref().map(|d| d.join("torrent-session")),
        torrent_cache_dir: app_data.as_ref().map(|d| d.join("torrents")),
        // Beside the ledger: a folder the page can't write (see ledger.rs).
        claims_file: app_data.as_ref().map(|d| d.join("ledger").join("torrent-claims.json")),
        give_up_after: match setting_u64(app, "torrentGiveUpMinutes", 0, 0, 10_080) {
            0 => None,
            m => Some(std::time::Duration::from_secs(m * 60)),
        },
        seed_time_limit: match setting_u64(app, "seedTimeLimitMinutes", 0, 0, 525_600) {
            0 => None,
            m => Some(std::time::Duration::from_secs(m * 60)),
        },
    }
}

fn setting_bool(app: &AppHandle, key: &str, default: bool) -> bool {
    read_setting(app, key).and_then(|v| v.as_bool()).unwrap_or(default)
}

/// Numeric setting clamped to `[min, max]`; anything unparseable = default.
fn setting_u64(app: &AppHandle, key: &str, default: u64, min: u64, max: u64) -> u64 {
    read_setting(app, key)
        .and_then(|v| v.as_f64())
        .filter(|f| f.is_finite() && *f >= 0.0)
        .map(|f| (f as u64).clamp(min, max))
        .unwrap_or(default)
}

/// If a magnet's metadata was cached on an earlier run (`<cache>/<infohash>
/// .torrent`), add from those bytes — the size and file list are then known
/// with zero peers — while keeping the magnet's own trackers.
fn with_cached_metadata(source: torrent::TorrentSource, cache_dir: Option<&std::path::Path>) -> torrent::TorrentSource {
    let torrent::TorrentSource::Url(ref magnet) = source else { return source };
    let Some(dir) = cache_dir else { return source };
    let Some(hash) = magnet_info_hash(magnet) else { return source };
    let path = dir.join(format!("{hash}.torrent"));
    match std::fs::read(&path) {
        Ok(bytes) if !bytes.is_empty() && bytes.len() as u64 <= MAX_TORRENT_FILE_BYTES => {
            torrent::TorrentSource::Bytes {
                key: magnet.clone(),
                bytes,
                trackers: magnet_trackers(magnet),
            }
        }
        _ => source,
    }
}

/// Lower-case hex info hash from a magnet's `xt=urn:btih:` (hex or base32).
pub(crate) fn magnet_info_hash(magnet: &str) -> Option<String> {
    let u = url::Url::parse(magnet).ok()?;
    if u.scheme() != "magnet" {
        return None;
    }
    let xt = u.query_pairs().find(|(k, _)| k == "xt").map(|(_, v)| v.into_owned())?;
    let raw = xt.strip_prefix("urn:btih:")?;
    match raw.len() {
        40 if raw.chars().all(|c| c.is_ascii_hexdigit()) => Some(raw.to_ascii_lowercase()),
        32 => base32_decode(raw).filter(|b| b.len() == 20).map(hex_lower),
        _ => None,
    }
}

/// http(s)/udp announce URLs from a magnet's `tr=` parameters.
pub(crate) fn magnet_trackers(magnet: &str) -> Vec<String> {
    url::Url::parse(magnet)
        .map(|u| {
            u.query_pairs()
                .filter(|(k, _)| k == "tr")
                .map(|(_, v)| v.into_owned())
                .filter(|t| {
                    url::Url::parse(t)
                        .map(|p| matches!(p.scheme(), "http" | "https" | "udp"))
                        .unwrap_or(false)
                })
                .take(MAX_EXTRA_TRACKERS)
                .collect()
        })
        .unwrap_or_default()
}

fn hex_lower(bytes: Vec<u8>) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// RFC 4648 base32 (what magnets use for `btih`), no padding.
fn base32_decode(s: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    let mut buf: u64 = 0;
    let mut bits = 0;
    for c in s.bytes() {
        let v = ALPHABET.iter().position(|&a| a == c.to_ascii_uppercase())? as u64;
        buf = (buf << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

/// Largest `.torrent` file we'll read into memory (real ones are KBs).
pub(crate) const MAX_TORRENT_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// A `.torrent` dropped onto the window or picked in the web demo. Drops are
/// handled as HTML5 events (so links dragged from a browser work too), and
/// those never expose a file's path — only its bytes. They're parsed, cached
/// exactly like metadata fetched from peers, and returned as a magnet for
/// that info hash, which `with_cached_metadata` turns straight back into
/// these bytes (trackers included) when the torrent is added.
#[tauri::command]
async fn import_torrent_file(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    // The bytes come as the raw request body. They used to be a JSON array of
    // numbers, about four times the file's size on the wire (a 16 MB
    // .torrent became ~60 MB of JSON: REVIEW 2026-09-23 P-3). The name rides
    // in a header, percent-encoded because headers must be ASCII.
    let (name, bytes) = torrent_upload(request.body(), request.headers())?;
    store_torrent_bytes(&app, &name, bytes)
}

/// The file name and bytes of a dropped .torrent, from the raw request.
fn torrent_upload<'a>(
    body: &'a tauri::ipc::InvokeBody,
    headers: &tauri::http::HeaderMap,
) -> Result<(String, &'a [u8]), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = body else {
        return Err("Expected the .torrent file's bytes".into());
    };
    let name = headers
        .get(TORRENT_NAME_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(decode_header_name)
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "dropped.torrent".into());
    Ok((name, bytes))
}

/// Header carrying a dropped .torrent's file name (see `import_torrent_file`).
const TORRENT_NAME_HEADER: &str = "x-prism-torrent-name";

/// Undo the page's `encodeURIComponent` of a file name.
fn decode_header_name(encoded: &str) -> String {
    url::form_urlencoded::parse(format!("n={encoded}").as_bytes())
        .find(|(k, _)| k == "n")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default()
}

/// Cache a `.torrent`'s bytes and return the magnet for its info hash — the
/// same cache `with_cached_metadata` reads back (trackers included) when the
/// torrent is added. Shared by drops, the web demo and watch folders.
pub(crate) fn store_torrent_bytes(app: &AppHandle, name: &str, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_TORRENT_FILE_BYTES {
        return Err(format!("{name} is not a valid .torrent file"));
    }
    let (hash, torrent_name) =
        torrent_identity(bytes).ok_or_else(|| format!("{name} is not a valid .torrent file"))?;
    let dir = torrent_session_config(app)
        .torrent_cache_dir
        .ok_or("Could not resolve the app data directory")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to store torrent: {e}"))?;
    std::fs::write(dir.join(format!("{hash}.torrent")), bytes)
        .map_err(|e| format!("Failed to store torrent: {e}"))?;
    let fallback = name.strip_suffix(".torrent").unwrap_or(name);
    log::info!("cached .torrent {hash}");
    Ok(magnet_for(&hash, torrent_name.as_deref().unwrap_or(fallback)))
}

/// Info hash (lower-case hex) and name of a `.torrent`, or None if it isn't one.
pub(crate) fn torrent_identity(bytes: &[u8]) -> Option<(String, Option<String>)> {
    let t = librqbit::torrent_from_bytes(bytes).ok()?;
    let hash = t.info_hash.as_string().to_ascii_lowercase();
    let name = t.info.data.validate().ok().and_then(|i| i.name().map(|n| n.into_owned()));
    Some((hash, name))
}

fn magnet_for(info_hash: &str, display_name: &str) -> String {
    let dn: String = url::form_urlencoded::byte_serialize(display_name.as_bytes()).collect();
    format!("magnet:?xt=urn:btih:{info_hash}&dn={dn}")
}

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
    Ok(torrent::TorrentSource::Bytes { key: validated, bytes, trackers: Vec::new() })
}

/// Restart the torrent engine so its settings apply now (see
/// `TorrentManager::restart`). The page pauses and resumes the torrents.
#[tauri::command]
async fn restart_torrent_engine(app: AppHandle) -> Result<usize, String> {
    Ok(app.state::<torrent::TorrentManager>().restart().await)
}

/// Stop a torrent. `delete_files` also removes its data from disk ("Remove
/// and delete files" — the frontend confirms first).
#[tauri::command]
async fn cancel_torrent(app: AppHandle, id: String, delete_files: Option<bool>) -> Result<(), String> {
    let manager = app.state::<torrent::TorrentManager>();
    manager.cancel_torrent(&app, &id, delete_files.unwrap_or(false)).await;
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

/// Session-wide torrent rate limits in bytes/sec (None/0 = unlimited). The
/// frontend merges the user's limits with the Quiet Hours override and pushes
/// the effective values; upload capping is what throttles seeding.
#[tauri::command]
async fn set_torrent_rate_limit(
    app: AppHandle,
    download_bps: Option<u64>,
    upload_bps: Option<u64>,
) -> Result<(), String> {
    let to_limit = |b: Option<u64>| {
        b.filter(|b| *b > 0)
            .and_then(|b| u32::try_from(b).ok())
            .and_then(std::num::NonZeroU32::new)
    };
    let manager = app.state::<torrent::TorrentManager>();
    manager.set_rate_limit(to_limit(download_bps), to_limit(upload_bps)).await;
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
    // Return the *resolved* path, not the string that was checked: the
    // extension allowlist in `open_file`/`player_load` and the OS opener must
    // see the same file the containment check saw. Returning the original
    // string let a symlink named `clip.mp4` → `payload.command` pass the
    // media check and then get opened as the `.command`.
    Ok(canonical_string(&resolved))
}

/// A canonical path as a string for consumers outside Rust (the OS opener,
/// mpv, `explorer /select`). On Windows `canonicalize` yields a `\\?\`
/// verbatim path, which those consumers don't all accept — strip the prefix.
fn canonical_string(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    s
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
    ledger::require_recorded(&app, &expanded)?;
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
        use std::os::windows::process::CommandExt;
        // raw_arg: Explorer parses its own command line and doesn't follow
        // the argv quoting Rust would apply (S-11).
        std::process::Command::new("explorer")
            .raw_arg(explorer_select_arg(&expanded)?)
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

/// The program that puts this machine to sleep or shuts it down. Split out
/// from `when_done` so the argv can be asserted in a test — a test that
/// actually suspended the machine running it would be a poor trade.
///
/// Only these fixed pairs are ever produced: the action comes from the
/// frontend, and nothing derived from it reaches a shell.
#[allow(clippy::needless_return)] // cfg-gated blocks need explicit returns
pub(crate) fn when_done_command(action: &str) -> Result<(String, Vec<String>), String> {
    let unknown = || format!("Unknown when-done action: {action}");
    #[cfg(target_os = "macos")]
    {
        return match action {
            // Both are what the Apple menu does — no privileges needed.
            "sleep" => Ok(("pmset".into(), vec!["sleepnow".into()])),
            "shutdown" => Ok((
                "osascript".into(),
                vec!["-e".into(), "tell application \"System Events\" to shut down".into()],
            )),
            _ => Err(unknown()),
        };
    }
    #[cfg(target_os = "windows")]
    {
        return match action {
            "sleep" => Ok((
                "rundll32.exe".into(),
                vec!["powrprof.dll,SetSuspendState".into(), "0,1,0".into()],
            )),
            // A minute's grace, which `shutdown /a` can still abort — so a
            // countdown someone missed isn't the end of the story.
            "shutdown" => Ok(("shutdown".into(), vec!["/s".into(), "/t".into(), "60".into()])),
            _ => Err(unknown()),
        };
    }
    #[cfg(target_os = "linux")]
    {
        return match action {
            "sleep" => Ok(("systemctl".into(), vec!["suspend".into()])),
            "shutdown" => Ok(("systemctl".into(), vec!["poweroff".into()])),
            _ => Err(unknown()),
        };
    }
}

/// Carry out what the user asked for once the queue finished. Deciding *when*
/// is the frontend's job (src/stores/completion.ts) — and it only decides that
/// after work has actually finished, never from a standing start.
#[tauri::command]
async fn when_done(app: AppHandle, action: String) -> Result<(), String> {
    // Quitting is in-process; there is no command for it.
    if action == "quit" {
        log::info!("when-done: quitting");
        app.exit(0);
        return Ok(());
    }
    let (program, args) = when_done_command(&action)?;
    log::info!("when-done: {action} via {program}");
    std::process::Command::new(&program)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't {action}: {e}"))
}

/// Explorer's `/select,"<path>"` argument. The path comes from a torrent's
/// name, so it's quoted explicitly and a `"` (which Windows paths can't
/// contain anyway) is refused rather than allowed to end the quoting (S-11).
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn explorer_select_arg(path: &str) -> Result<String, String> {
    if path.contains('"') {
        return Err("That path can't be shown in Explorer".into());
    }
    Ok(format!("/select,\"{}\"", path.replace('/', "\\")))
}

/// What one folder is holding, and what the disk it sits on has left.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSummary {
    pub folder: String,
    pub files: u64,
    pub bytes: u64,
    pub free_bytes: u64,
    /// True when the walk stopped early — the number is a floor, not a total,
    /// and the UI says so rather than showing a wrong figure confidently.
    pub partial: bool,
}

/// Cap the walk: the download folder is wherever the user pointed Prism,
/// which can be a network share or an enormous tree. A settings tile is not
/// worth an unbounded traversal, so it stops and admits it stopped.
const STORAGE_WALK_MAX_ENTRIES: u64 = 50_000;
const STORAGE_WALK_MAX_DEPTH: usize = 8;

pub(crate) fn walk_storage(root: &std::path::Path) -> (u64, u64, bool) {
    let (mut files, mut bytes, mut seen) = (0u64, 0u64, 0u64);
    let mut partial = false;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            seen += 1;
            if seen > STORAGE_WALK_MAX_ENTRIES {
                return (files, bytes, true);
            }
            // Metadata, not follow: a symlink into another tree would be
            // counted twice, or walked forever.
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                if depth < STORAGE_WALK_MAX_DEPTH {
                    stack.push((entry.path(), depth + 1));
                } else {
                    partial = true;
                }
            } else if meta.is_file() {
                files += 1;
                bytes += meta.len();
            }
        }
    }
    (files, bytes, partial)
}

#[tauri::command]
async fn storage_summary(app: AppHandle, folder: String) -> Result<StorageSummary, String> {
    // Only a folder downloads may go to: the walk would otherwise read any
    // tree the page named (REVIEW 2026-09-23 S-4). It runs on the blocking
    // pool, since the folder may be a network share or a huge tree (P-2).
    let expanded = validate_download_path(&folder, &picked_dirs(&app))?;
    tauri::async_runtime::spawn_blocking(move || summarize_storage(expanded))
        .await
        .map_err(|e| format!("Storage summary: {e}"))?
}

fn summarize_storage(expanded: String) -> Result<StorageSummary, String> {
    let path = std::path::PathBuf::from(&expanded);
    // A folder that doesn't exist yet is empty rather than an error: Prism
    // creates it on the first download.
    let (files, bytes, partial) = if path.is_dir() { walk_storage(&path) } else { (0, 0, false) };
    // Free space comes from the nearest existing ancestor, so the figure is
    // still right before the folder has been created.
    let mut probe = path.as_path();
    let free_bytes = loop {
        match fs2::available_space(probe) {
            Ok(free) => break free,
            Err(_) => match probe.parent() {
                Some(parent) => probe = parent,
                None => break 0,
            },
        }
    };
    Ok(StorageSummary { folder: expanded, files, bytes, free_bytes, partial })
}

/// Most items one call may trash. A bulk action over a selection, not a way
/// to hand the backend an unbounded list.
const MAX_TRASH_PATHS: usize = 1000;

/// The paths a trash request is actually allowed to touch. Every one goes
/// through the same check as any other path from the webview — inside the
/// allowed roots, and really there — before anything is deleted.
///
/// Split out from the command so the refusals are testable without a test
/// that throws real files away.
///
/// `protected` names folders that may never go, on top of the user's own
/// folders (home, Downloads, Documents…): the download destination, category
/// folders and the like. Neither they nor any folder that contains one can be
/// trashed. Before 2.0.1 a single-file torrent could record the shared
/// destination as its path, and trashing that row trashed every download
/// (REVIEW 2026-09-23 B-3, S-3).
pub(crate) fn trashable_paths(
    paths: &[String],
    roots: &[PathBuf],
    protected: &[PathBuf],
) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("Nothing to move to the Trash".into());
    }
    if paths.len() > MAX_TRASH_PATHS {
        return Err(format!("Too many items at once (limit {MAX_TRASH_PATHS})"));
    }
    let canon = |p: &PathBuf| p.canonicalize().unwrap_or_else(|_| p.clone());
    let mut keep: Vec<PathBuf> = [
        dirs::home_dir(),
        dirs::download_dir(),
        dirs::desktop_dir(),
        dirs::document_dir(),
        dirs::video_dir(),
        dirs::audio_dir(),
        dirs::picture_dir(),
        dirs::public_dir(),
    ]
    .into_iter()
    .flatten()
    .chain(roots.iter().cloned())
    .chain(protected.iter().cloned())
    .map(|p| canon(&p))
    .collect();
    keep.dedup();

    paths
        .iter()
        .map(|p| {
            // Folders too: a multi-file torrent is one folder, not a list of files.
            let valid = validate_open_path(p, true, roots)?;
            let candidate = std::path::Path::new(&valid);
            if candidate.parent().is_none() {
                return Err("Prism won't move a whole drive to the Trash".to_string());
            }
            // `keep` inside `candidate` means the candidate is that folder or
            // one of its ancestors.
            if keep.iter().any(|k| strip_prefix_fs(k, candidate).is_some()) {
                let name = candidate
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| valid.clone());
                return Err(format!(
                    "Prism won't move \"{name}\" to the Trash: it's a folder your downloads or your own files live in, not a download"
                ));
            }
            Ok(valid)
        })
        .collect()
}

/// Folders from the settings that `move_to_trash` must never remove: where
/// downloads go, where finished ones move to, category destinations and
/// watch folders.
fn protected_folders(app: &AppHandle) -> Vec<PathBuf> {
    folders_from_settings(app, true)
}

/// Where downloads land: the default folder, the move-completed folder and
/// category destinations.
pub(crate) fn download_destinations(app: &AppHandle) -> Vec<PathBuf> {
    folders_from_settings(app, false)
}

fn folders_from_settings(app: &AppHandle, with_watch_folders: bool) -> Vec<PathBuf> {
    let text = |v: Option<&serde_json::Value>| {
        v.and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| PathBuf::from(expand_tilde(s)))
    };
    let path = match app.path().app_data_dir() {
        Ok(dir) => dir.join("settings.json"),
        Err(_) => return Vec::new(),
    };
    let Some(settings) = settings_snapshot(&path) else { return Vec::new() };
    let mut out: Vec<PathBuf> = ["defaultSaveFolder", "moveCompletedTo"]
        .iter()
        .filter_map(|k| text(settings.get(*k)))
        .collect();
    for (list, key) in [("categories", "destination"), ("watchFolders", "path")] {
        if list == "watchFolders" && !with_watch_folders {
            continue;
        }
        if let Some(items) = settings.get(list).and_then(|v| v.as_array()) {
            out.extend(items.iter().filter_map(|i| text(i.get(key))));
        }
    }
    out
}

/// Move finished downloads to the OS Trash. Deliberately not a delete: this
/// is the only thing in Prism that removes a file someone downloaded, so it
/// has to be something they can undo outside the app.
#[tauri::command]
async fn move_to_trash(app: AppHandle, paths: Vec<String>) -> Result<usize, String> {
    let validated = trashable_paths(&paths, &picked_dirs(&app), &protected_folders(&app))?;
    // Only what Prism downloaded: the page's own records once pointed a row
    // at the whole download folder (B-3); the ledger is Rust's record.
    for path in &validated {
        ledger::require_recorded(&app, path)?;
    }
    let count = validated.len();
    // Moving a large folder to the Trash can take a while: off the async workers (P-2).
    tauri::async_runtime::spawn_blocking(move || trash::delete_all(&validated))
        .await
        .map_err(|e| format!("Couldn't move to the Trash: {e}"))?
        .map_err(|e| format!("Couldn't move to the Trash: {e}"))?;
    log::info!("moved {count} item(s) to the Trash");
    Ok(count)
}

/// Most paths one missing-files check may ask about (a Library's worth).
const MAX_MISSING_CHECK: usize = 5000;

/// Which Library files have gone (moved or deleted outside Prism), so rows
/// can say so instead of failing when clicked. Recorded downloads only
/// (`ledger::missing`).
#[tauri::command]
async fn missing_files(app: AppHandle, paths: Vec<String>) -> Result<Vec<bool>, String> {
    if paths.len() > MAX_MISSING_CHECK {
        return Err(format!("Too many paths at once (limit {MAX_MISSING_CHECK})"));
    }
    tauri::async_runtime::spawn_blocking(move || ledger::missing(&app, &paths))
        .await
        .map_err(|e| format!("Checking files: {e}"))
}

/// The OS progress bar's state for a given overall progress.
///
/// Pure so the mapping is testable without a window: `None` hides the bar
/// entirely, which is what "nothing is downloading" has to mean — a bar left
/// sitting at 100% reads as a stuck download rather than a finished one.
pub(crate) fn progress_state(
    percent: Option<u64>,
    paused: bool,
) -> (Option<tauri::window::ProgressBarStatus>, Option<u64>) {
    use tauri::window::ProgressBarStatus;
    match percent {
        None => (Some(ProgressBarStatus::None), None),
        Some(p) => (
            Some(if paused { ProgressBarStatus::Paused } else { ProgressBarStatus::Normal }),
            Some(p.min(100)),
        ),
    }
}

/// Dock (macOS) and taskbar (Windows) progress. Deciding *what* the number is
/// belongs to src/stores/progress.ts; this only shows it.
#[tauri::command]
async fn set_progress(app: AppHandle, percent: Option<u64>, paused: bool) -> Result<(), String> {
    use tauri::Manager;
    let (status, progress) = progress_state(percent, paused);
    // No window yet (or already gone) is not a failure worth reporting: the
    // bar is decoration, and the caller is a render effect.
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    window
        .set_progress_bar(tauri::window::ProgressBarState { status, progress })
        .map_err(|e| format!("Couldn't set the progress bar: {e}"))
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
async fn ffmpeg_available(app: AppHandle) -> bool {
    find_ffmpeg_blocking(&app).await.is_some()
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
    settings_snapshot(&path)?.get(key).cloned()
}

/// settings.json parsed once per change rather than once per key: starting a
/// single download reads a dozen settings. The file is read every time (it is
/// a few KB) and parsed only when its bytes differ from the cached copy. Size
/// and modification time were not enough: a same-length edit (`safari` →
/// `chrome`) within one mtime tick was read stale (REVIEW 2026-09-26 L7).
fn settings_snapshot(path: &std::path::Path) -> Option<std::sync::Arc<serde_json::Value>> {
    type Snapshot = (PathBuf, Vec<u8>, std::sync::Arc<serde_json::Value>);
    static CACHE: std::sync::Mutex<Option<Snapshot>> = std::sync::Mutex::new(None);

    let bytes = std::fs::read(path).ok()?;
    if let Ok(guard) = CACHE.lock() {
        if let Some((p, b, value)) = guard.as_ref() {
            if p == path && *b == bytes {
                return Some(value.clone());
            }
        }
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let value = std::sync::Arc::new(value);
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some((path.to_path_buf(), bytes, value.clone()));
    }
    Some(value)
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

/// Torrent seeding policy, whitelisted; defaults to seed-to-ratio (target from
/// `seedRatioTarget`, clamped 0.1..=10, default 1.0).
pub fn seeding_policy(app: &AppHandle) -> torrent::SeedingPolicy {
    match read_setting(app, "seedingPolicy")
        .and_then(|v| v.as_str().map(str::to_string))
        .as_deref()
    {
        Some("stop") => torrent::SeedingPolicy::Stop,
        Some("seed") => torrent::SeedingPolicy::Forever,
        _ => {
            let target = read_setting(app, "seedRatioTarget")
                .and_then(|v| v.as_f64())
                .filter(|f| f.is_finite())
                .map(|f| f.clamp(0.1, 10.0))
                .unwrap_or(1.0);
            torrent::SeedingPolicy::Ratio(target)
        }
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

/// Whether yt-dlp is told `--force-ipv4` (default on — it was hardcoded
/// before 1.9, because many sites throttle IPv6 downloads).
pub fn force_ipv4(app: &AppHandle) -> bool {
    setting_bool(app, "forceIpv4", true)
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

    if !roots.iter().any(|base| strip_prefix_fs(resolved, base).is_some()) {
        return Err(
            "Path is outside your home folder. Pick the folder in Settings → Download location to allow it."
                .into(),
        );
    }
    if let Some(home) = home.as_deref() {
        if let Some(why) = denied_subtree(resolved, home) {
            return Err(format!("Prism won't write or open files in {} (system/config location)", why));
        }
    }
    if let Some(dir) = program_dir_containing(resolved, &search_path_dirs(), home.as_deref()) {
        return Err(format!(
            "Prism won't write or open files in {} — programs are run from there",
            dir.display()
        ));
    }
    Ok(())
}

/// The directories on this process's PATH, canonical, minus any that is the
/// home folder or contains it (a PATH with `~` or `/` in it would otherwise
/// deny everything).
fn search_path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.is_absolute())
        .map(|p| p.canonicalize().unwrap_or(p))
        .collect()
}

/// The PATH directory `resolved` is in, if any. A file a torrent names, put
/// in `~/go/bin` or `/opt/homebrew/bin`, would run in place of a real command
/// the next time someone typed it (REVIEW 2026-09-26 L3). Directories that
/// are the home folder or above it are ignored: those can't be meant.
fn program_dir_containing(resolved: &std::path::Path, path_dirs: &[PathBuf], home: Option<&std::path::Path>) -> Option<PathBuf> {
    path_dirs
        .iter()
        .filter(|d| d.parent().is_some())
        .filter(|d| !home.is_some_and(|h| strip_prefix_fs(h, d).is_some()))
        .find(|d| strip_prefix_fs(resolved, d).is_some())
        .cloned()
}

/// Folders outside home that may never become a download root, however the
/// user picked them: the top of a drive, the OS's own trees, and where
/// programs are installed or run from (REVIEW 2026-09-26 L3). A picked root
/// is otherwise trusted wholesale, and torrents name their own files.
fn system_location(resolved: &std::path::Path, path_dirs: &[PathBuf], home: Option<&std::path::Path>) -> Option<String> {
    if resolved.parent().is_none() {
        return Some("the top level of a drive".into());
    }
    let mut system: Vec<PathBuf> = Vec::new();
    #[cfg(unix)]
    system.extend(
        [
            "/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/etc", "/opt", "/private/etc",
            "/private/var/db", "/var/db", "/dev", "/boot", "/lib", "/lib64", "/snap",
        ]
        .iter()
        .map(PathBuf::from),
    );
    #[cfg(windows)]
    system.extend(
        ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"]
            .iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from),
    );
    if let Some(dir) = system.iter().find(|d| strip_prefix_fs(resolved, d).is_some()) {
        return Some(dir.display().to_string());
    }
    program_dir_containing(resolved, path_dirs, home).map(|d| d.display().to_string())
}

/// Whether paths compare case-insensitively here: the default filesystems on
/// macOS (APFS) and Windows (NTFS) are, so `~/library` IS `~/Library` (S-9).
const CASE_INSENSITIVE_FS: bool = cfg!(any(target_os = "macos", target_os = "windows"));

fn same_component(a: &std::ffi::OsStr, b: &std::ffi::OsStr) -> bool {
    if CASE_INSENSITIVE_FS {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// `path.strip_prefix(base)`, component-wise and case-insensitive where the
/// filesystem is. None when `path` is not inside `base`.
fn strip_prefix_fs(path: &std::path::Path, base: &std::path::Path) -> Option<PathBuf> {
    let mut rest = path.components();
    for b in base.components() {
        let p = rest.next()?;
        if !same_component(p.as_os_str(), b.as_os_str()) {
            return None;
        }
    }
    Some(rest.as_path().to_path_buf())
}

/// Sensitive locations under the home directory that must never receive a
/// download or be opened from the app, even though they're "inside home":
/// launch agents, shell rc files, SSH/GPG keys, browser profiles, Windows
/// Startup, Linux autostart/launchers. Returns a short description of the
/// matched rule.
fn denied_subtree(resolved: &std::path::Path, home: &std::path::Path) -> Option<String> {
    let rel = strip_prefix_fs(resolved, home)?;
    let mut parts = rel.components();
    let first = parts.next()?.as_os_str().to_owned();
    let name = first.to_string_lossy();
    // Any hidden entry directly under home: ~/.ssh, ~/.config, ~/.gnupg,
    // ~/.zshrc, ~/.local/bin, ~/.local/share/applications, ~/.config/autostart…
    if name.starts_with('.') {
        return Some(format!("~/{}", name));
    }
    let denied: &[&str] = if cfg!(target_os = "macos") {
        // LaunchAgents, Preferences, Application Support, Keychains, Safari…
        &["Library"]
    } else if cfg!(target_os = "windows") {
        // Roaming/Local AppData: Start Menu\Programs\Startup lives in here.
        &["AppData"]
    } else {
        // ~/bin is on many distros' default PATH (Debian/Ubuntu ~/.profile).
        &["bin"]
    };
    if let Some(d) = denied.iter().find(|d| same_component(&first, std::ffi::OsStr::new(d))) {
        return Some(format!("~/{}", d));
    }
    // A launcher dropped straight onto the Linux desktop is one double-click
    // (and on some desktops, one "trust" prompt) away from running.
    if cfg!(target_os = "linux")
        && name == "Desktop"
        && parts.clone().count() == 1
        && rel.extension().is_some_and(|e| e.eq_ignore_ascii_case("desktop"))
    {
        return Some("~/Desktop/*.desktop".into());
    }
    None
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

    path_is_allowed(&resolved, extra_roots).map_err(|e| {
        log::warn!("refused download path {expanded}: {e}");
        format!("Invalid download path: {} ({})", e, expanded)
    })?;
    if is_home_itself(&resolved) {
        log::warn!("refused download path {expanded}: the home folder itself");
        return Err(HOME_ITSELF.into());
    }

    Ok(expanded)
}

const HOME_ITSELF: &str =
    "Prism won't save loose files straight into your home folder — choose or create a folder inside it";

/// Whether `resolved` is the home folder itself. Loose files there sit beside
/// the shell's startup files, and a torrent names its own file (REVIEW
/// 2026-09-26 H1), so home is never a destination — only folders inside it.
fn is_home_itself(resolved: &std::path::Path) -> bool {
    dirs::home_dir()
        .map(|h| h.canonicalize().unwrap_or(h))
        .and_then(|home| strip_prefix_fs(resolved, &home))
        .is_some_and(|rest| rest.as_os_str().is_empty())
}

// ── User-picked download roots ───────────────────────────────────────

/// Folders the user chose in the native picker, so downloads can go to an
/// external drive or NAS while everything else stays confined to home.
/// Kept in Rust-managed state and persisted OUTSIDE the app-data dir (which
/// the webview can write through the fs plugin) — the webview must not be
/// able to grant itself new roots by editing a file.
pub struct PickedDirs(std::sync::Mutex<Vec<PathBuf>>);

fn picked_dirs_file() -> Option<PathBuf> {
    dirs::preference_dir().map(|d| d.join(format!("{}.allowed-dirs.json", migrate::NEW_ID)))
}

/// Before 2.0 the file carried the old identifier. Read it until the first
/// save under the new name; never written again.
fn legacy_picked_dirs_file() -> Option<PathBuf> {
    dirs::preference_dir().map(|d| d.join(format!("{}.allowed-dirs.json", migrate::OLD_ID)))
}

fn load_picked_dirs() -> Vec<PathBuf> {
    picked_dirs_file()
        .filter(|f| f.exists())
        .or_else(legacy_picked_dirs_file)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        // Picked before 2.2.1 refused these (L3): no longer a root.
        .filter(|p| {
            let home = dirs::home_dir().and_then(|h| h.canonicalize().ok());
            let canon = p.canonicalize().unwrap_or_else(|_| p.clone());
            let refused = system_location(&canon, &search_path_dirs(), home.as_deref());
            if let Some(what) = &refused {
                log::warn!("download folder {} no longer allowed: {what}", p.display());
            }
            refused.is_none()
        })
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
/// Largest backup Prism will read: a full Library of 2,000 entries is a few MB.
const MAX_BACKUP_BYTES: u64 = 32 * 1024 * 1024;

/// Open a Prism backup the user picks and return its text. The dialog runs
/// here rather than in the page, so the page never names a file to read: the
/// user's choice is the only way in, as with `pick_download_dir`.
#[tauri::command]
async fn open_backup_file(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose a Prism backup to import")
        .add_filter("Prism backup", &["json"])
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx.await.map_err(|_| "File picker was closed".to_string())? else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| format!("Invalid file: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let size = std::fs::metadata(&path).map_err(|e| format!("Couldn't read that file: {e}"))?.len();
        if size > MAX_BACKUP_BYTES {
            return Err("That file is too large to be a Prism backup".to_string());
        }
        std::fs::read_to_string(&path).map(Some).map_err(|e| format!("Couldn't read that file: {e}"))
    })
    .await
    .map_err(|e| format!("Couldn't read that file: {e}"))?
}

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
    if is_home_itself(&resolved) {
        return Err(HOME_ITSELF.into());
    }
    let home = dirs::home_dir().and_then(|h| h.canonicalize().ok());
    if let Some(what) = system_location(&resolved, &search_path_dirs(), home.as_deref()) {
        return Err(format!("Prism can't save downloads in {what} — choose a folder of your own."));
    }
    if let Some(state) = app.try_state::<PickedDirs>() {
        let mut guard = state.0.lock().map_err(|_| "State lock poisoned".to_string())?;
        if !guard.iter().any(|d| d == &resolved) {
            log::info!("download folder allowed by user pick: {}", resolved.display());
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
                .any(|ext| std::path::Path::new(&download_manager::template_file(tpl, ext)).exists())
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

/// `find_ffmpeg` from async code. Its last resort runs `which`/`where`, a
/// child process that must not hold up an async worker (REVIEW 2026-09-23 P-2).
pub async fn find_ffmpeg_blocking(app: &AppHandle) -> Option<String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || find_ffmpeg(&app)).await.ok().flatten()
}

/// Find ffmpeg, remembering where it was: every download asks, and the last
/// resort spawns `which`. Only a find is remembered (ffmpeg may be installed
/// while Prism runs), and only while that file is still there.
pub fn find_ffmpeg(app: &AppHandle) -> Option<String> {
    static FOUND: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
    if let Some(path) = FOUND.lock().ok().and_then(|g| g.clone()) {
        if std::path::Path::new(&path).exists() {
            return Some(path);
        }
    }
    let found = locate_ffmpeg(app);
    if let Ok(mut guard) = FOUND.lock() {
        guard.clone_from(&found);
    }
    found
}

/// Look for ffmpeg. Desktop apps may not have it in PATH, so common
/// locations per platform are checked first.
fn locate_ffmpeg(app: &AppHandle) -> Option<String> {
    // The LGPL ffmpeg shipped beside the player's libraries wins over whatever
    // is on the machine: it is the build Prism was tested against, and a
    // Finder-launched app often has no useful PATH at all.
    if let Ok(resources) = app.path().resource_dir() {
        let name = if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" };
        let bundled = resources.join("lib").join("bin").join(name);
        if bundled.exists() {
            return Some(bundled.to_string_lossy().into_owned());
        }
    }

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
/// Home folders, but also other drives and mounts (`/Volumes/Media/…`, `D:\\…`,
/// a share), temp and `~/…` paths: a download's path names what it is
/// wherever it lives (REVIEW 2026-09-26 L1). Runs on across single spaces,
/// since file names have them; scrubbing a few words too many is the safe
/// way to be wrong.
static PATH_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(
        r#"(?:/Users/|/home/|/Volumes/|/mnt/|/media/|/run/media/|/private/|/var/folders/|/tmp/|~/|[A-Za-z]:\\|\\\\[^\s\\'"]+\\)[^\s'":<>]*(?: [^\s'":<>]+)*"#,
    )
    .unwrap()
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
    // The SDK fills this in with the machine's hostname, which is usually
    // the owner's name ("Rajats-MacBook-Pro"): not ours to send (L1).
    event.server_name = None;
    event.user = None;
    event.extra.clear();
    Some(event)
}

// ── App setup ────────────────────────────────────────────────────────

/// Bring Prism to the front, from wherever it is.
///
/// Generic over the runtime because the global-shortcut handler is handed an
/// `AppHandle<R>` rather than the concrete one.
///
/// `unminimize` matters: showing and focusing a minimised window leaves it
/// minimised, so "Open Prism" from the tray did nothing useful in exactly the
/// case someone reaches for it.
pub(crate) fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
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
            "quit" => lifecycle::request_quit(app),
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
    // Before any thread starts: this sets process environment (player.rs).
    #[cfg(target_os = "macos")]
    player::use_bundled_vulkan_driver();
    #[cfg(target_os = "macos")]
    player::keep_prism_dock_icon();

    // Before the builder: Tauri opens windows and plugins open their files
    // before `setup`, so data must already be under the new identifier.
    let migration = migrate::run_once();
    // Hidden: run only the migration and report it (release verification).
    if std::env::args().any(|a| a == "--prism-migrate-only") {
        println!("{}", serde_json::to_string(&migration).unwrap_or_default());
        return;
    }

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
            // Same helper as the tray and the global shortcut: a second launch
            // should raise Prism even when the first one is minimised, which a
            // bare set_focus doesn't do.
            show_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .manage(DownloadManager::new())
        .manage(http_engine::HttpEngine::new())
        .manage(torrent::TorrentManager::new())
        .manage(stream_server::StreamServer::new())
        .manage(player_state::PlayerState::new())
        .manage(store::Store::new())
        .manage(queue::QueueManager::new())
        .manage(PickedDirs(std::sync::Mutex::new(load_picked_dirs())))
        .manage(updater::PendingUpdate::default())
        // Embedded player (separate "player" window). The plugin cleans up its
        // mpv instance on window close; macOS embeds via the window's NSView.
        .plugin(tauri_plugin_libmpv::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        // Optional system-wide hotkeys. Registers nothing until the user
        // assigns one (see shortcuts.rs).
        .plugin(shortcuts::plugin())
        // Remembers window size/position across launches.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Keep mpv's adopted video window glued to the player window on
        // resize (see player.rs module docs).
        .on_window_event(|window, event| {
            // Closing the main window hides it (or asks before quitting):
            // downloads live in this process (see lifecycle.rs).
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    lifecycle::on_main_close_requested(window, api);
                }
            }
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
            migrate::log_outcome();

            // The webview may only write top-level JSON files in app data
            // (capabilities/default.json), so it can't create the directory.
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(dir);
            }

            // Re-take the user's global hotkeys, if they assigned any. Reads
            // settings.json, so it belongs after the directory above exists.
            shortcuts::apply_saved(app.handle());

            // The queue: loaded from the database and scheduled from Rust,
            // whatever the window is doing (queue.rs).
            queue::start(app.handle());

            // A menu that fails to build is worth a log line, not a refusal to
            // start: the app is entirely usable without it.
            if let Err(e) = app_menu::install(app.handle()) {
                log::warn!("menu: not installed: {e}");
            }

            // The only thread mpv is ever called from (see mpv_worker.rs).
            app.manage(mpv_worker::MpvWorker::spawn(app.handle().clone())?);
            #[cfg(debug_assertions)]
            player::verify_player_from_env(app.handle())?;

            // Like the menu: without a tray Prism still works — but a hidden
            // window would then have no way back on Windows/Linux, so closing
            // it quits instead (lifecycle::close_to_tray).
            match setup_tray(app) {
                Ok(()) => lifecycle::set_tray_available(true),
                Err(e) => log::warn!("tray: not available: {e}"),
            }

            // yt-dlp temp folders earlier runs couldn't clean up (R1.4).
            tauri::async_runtime::spawn_blocking(|| {
                let removed = spawn::sweep_stale_unpack_dirs(&std::env::temp_dir());
                if removed > 0 {
                    log::info!("removed {removed} stale yt-dlp temp folder(s)");
                }
            });

            // Watch folders (none configured = a cached settings read every
            // few seconds).
            watch::spawn(app.handle().clone());

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
            lookup::inspect_url,
            thumbnails::cache_thumbnail,
            missing_files,
            restart_torrent_engine,
            store::store_load,
            store::store_save_queue,
            store::store_update_history,
            store::store_save_doc,
            queue::queue_snapshot,
            queue::queue_add,
            queue::queue_remove,
            queue::queue_pause,
            queue::queue_resume,
            queue::queue_cancel,
            queue::queue_retry,
            queue::queue_pause_all,
            queue::queue_resume_all,
            queue::queue_clear_completed,
            queue::queue_reorder,
            queue::queue_set_settings,
            queue::queue_update_torrent_files,
            queue::queue_remove_with_data,
            queue::queue_restart_torrent_engine,
            queue::when_done_cancel,
            start_download,
            cancel_download,
            http_engine::probe_direct_link,
            http_engine::start_http_download,
            http_engine::cancel_http_download,
            http_engine::set_http_rate_limit,
            template::preview_filename_template,
            start_torrent,
            cancel_torrent,
            pause_torrent,
            resume_torrent,
            update_torrent_files,
            parse_torrent,
            set_torrent_rate_limit,
            reannounce_torrent,
            recheck_torrent,
            torrent_peers,
            torrent_details,
            open_file,
            open_external,
            show_in_folder,
            get_default_download_path,
            get_launch_torrent_files,
            import_torrent_file,
            pick_download_dir,
            open_backup_file,
            client_import::import_torrent_client,
            get_app_version,
            ffmpeg_available,
            engine::get_ytdlp_version,
            engine::update_ytdlp,
            engine::reset_ytdlp,
            engine::get_engine_info,
            engine::check_engine_update,
            updater::check_app_update,
            updater::install_app_update,
            player::fixup_player_video,
            player::player_available,
            player::player_init,
            player::player_destroy,
            player::player_load,
            player::player_load_stream,
            player::player_open_file,
            player::player_save_position,
            player::player_resume_position,
            player::player_add_subtitle,
            player::player_sibling_subtitles,
            player::player_set_mini,
            player::player_seek,
            player::player_set,
            when_done,
            storage_summary,
            move_to_trash,
            rss::rss_fetch,
            shortcuts::set_shortcuts,
            set_progress,
            content_index::index_download,
            convert::convert_file,
            convert::cancel_convert,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Every window gone without anyone choosing Quit (e.g. the player
            // closing while the main window is somehow destroyed): ask rather
            // than end whatever is running. `app.exit` carries a code and
            // passes straight through.
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = &event {
                api.prevent_exit();
                lifecycle::request_quit(app);
                return;
            }
            // The Dock icon brings a hidden window back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = &event {
                show_main_window(app);
                return;
            }
            // Downloads must not outlive the app: yt-dlp's forked worker is
            // reparented to init and keeps downloading otherwise, racing the
            // next launch for the same files (see `proc`).
            if matches!(event, tauri::RunEvent::Exit) {
                let manager = app.state::<DownloadManager>();
                tauri::async_runtime::block_on(manager.kill_all());
                // Conversions too: ffmpeg has its own process group.
                convert::kill_all();
                // Ledger saves are batched; write what's waiting (M3).
                ledger::flush(app);
            }
        });
}

#[cfg(test)]
mod tests {
    // As yt-dlp 2026.08.19 prints a channel's Videos tab.
    #[test]
    fn a_youtube_list_knows_its_rss_feed() {
        let lines = [r#"{"ie_key":"Youtube","url":"https://www.youtube.com/watch?v=a1","title":"A","playlist_id":"UCBR8-60-B28hp2BmDPdntcQ","live_status":"is_upcoming"}"#];
        let list = super::playlist_from_lines(&lines);
        assert_eq!(list.feed_url.as_deref(), Some("https://www.youtube.com/feeds/videos.xml?channel_id=UCBR8-60-B28hp2BmDPdntcQ"));
        assert_eq!(list.entries[0].live_status.as_deref(), Some("is_upcoming"));
        assert_eq!(
            super::youtube_feed_url("PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf").as_deref(),
            Some("https://www.youtube.com/feeds/videos.xml?playlist_id=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf")
        );
        assert_eq!(super::youtube_feed_url("x&y=1"), None);
    }

    #[test]
    fn flat_list_lines_keep_their_title_and_their_sites() {
        let lines = [
            r#"{"_type":"url","ie_key":"Youtube","url":"https://www.youtube.com/watch?v=a1","title":"One","playlist_title":"Talks 2026"}"#,
            r#"{"_type":"url","ie_key":"Vimeo","url":"https://vimeo.com/22","title":"Two","playlist_title":"Talks 2026"}"#,
            r#"{"_type":"url","ie_key":"Dailymotion","url":"x9","title":"No URL"}"#,
            "not json",
        ];
        let list = super::playlist_from_lines(&lines);
        assert_eq!(list.title, "Talks 2026");
        assert_eq!(list.feed_url, None, "no playlist_id on these lines");
        let urls: Vec<&str> = list.entries.iter().map(|e| e.url.as_str()).collect();
        assert_eq!(urls, ["https://www.youtube.com/watch?v=a1", "https://vimeo.com/22"]);
    }
    #[test]
    fn partial_bytes_counts_this_downloads_parts_only() {
        let dir = std::env::temp_dir().join(format!("prism-partial-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Talk.f137.mp4.part"), vec![0u8; 300]).unwrap();
        std::fs::write(dir.join("Talk.f140.m4a.part"), vec![0u8; 50]).unwrap();
        std::fs::write(dir.join("Talk.mp4.part-Frag7"), vec![0u8; 5]).unwrap();
        std::fs::write(dir.join("Other.mp4.part"), vec![0u8; 999]).unwrap();
        std::fs::write(dir.join("Talk.en.srt"), vec![0u8; 999]).unwrap();
        let template = dir.join("Talk.%(ext)s").to_string_lossy().into_owned();
        assert_eq!(super::partial_bytes(&template), 355);
        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::*;

    #[test]
    fn templated_output_path_keeps_folders_and_escapes_percent() {
        let vars = template::TemplateVars {
            title: Some("100% Pure".into()),
            uploader: Some("Chan/nel".into()),
            ..Default::default()
        };
        assert_eq!(
            templated_output_path("/dl/", "{uploader}/{title}", &vars).unwrap(),
            "/dl/Chan-nel/100%% Pure.%(ext)s"
        );
        // Regression (REVIEW 2026-09-23 B-10): the folder is escaped as well.
        assert_eq!(
            templated_output_path("/dl/100% Music", "{title}", &vars).unwrap(),
            "/dl/100%% Music/100%% Pure.%(ext)s"
        );
        assert!(templated_output_path("/dl", "{nope}", &vars).is_err());
    }

    /// `matches!` rather than `assert_eq!` — ProgressBarStatus isn't declared
    /// here and comparing it would rest on a derive this doesn't control.
    #[test]
    fn progress_state_hides_the_bar_when_there_is_nothing_to_show() {
        use tauri::window::ProgressBarStatus;

        let (status, progress) = progress_state(None, false);
        assert!(matches!(status, Some(ProgressBarStatus::None)));
        assert_eq!(progress, None, "a hidden bar carries no number");

        let (status, progress) = progress_state(Some(42), false);
        assert!(matches!(status, Some(ProgressBarStatus::Normal)));
        assert_eq!(progress, Some(42));

        let (status, _) = progress_state(Some(42), true);
        assert!(matches!(status, Some(ProgressBarStatus::Paused)));

        // The OS takes 0-100; a bad number from an engine must not reach it.
        let (_, progress) = progress_state(Some(500), false);
        assert_eq!(progress, Some(100));
    }

    /// The refusals are what matter here. Nothing is actually trashed: a test
    /// that threw real files away to prove it could would be a bad trade.
    #[test]
    fn trashable_paths_refuses_what_it_should() {
        assert!(trashable_paths(&[], &[], &[]).is_err(), "an empty request is a mistake, not a no-op");

        let many: Vec<String> = (0..MAX_TRASH_PATHS + 1).map(|i| format!("/tmp/{i}")).collect();
        assert!(trashable_paths(&many, &[], &[]).is_err(), "an unbounded list is refused");

        // Exists, but outside every allowed root.
        assert!(trashable_paths(&["/etc/hosts".to_string()], &[], &[]).is_err());

        // A real file under a root the user picked is fine — and so is the
        // folder itself, because a multi-file torrent is a folder.
        let dir = std::env::temp_dir().join(format!("prism-trash-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("inner")).unwrap();
        let file = dir.join("inner/a.bin");
        std::fs::write(&file, b"x").unwrap();
        let roots = vec![dir.clone()];
        assert!(trashable_paths(&[file.to_string_lossy().into_owned()], &roots, &[]).is_ok());
        assert!(trashable_paths(&[dir.join("inner").to_string_lossy().into_owned()], &roots, &[]).is_ok());

        // Regression (REVIEW 2026-09-23 B-3, S-3): never a root, a protected
        // folder, or anything that contains one.
        let s = |p: &std::path::Path| p.to_string_lossy().into_owned();
        assert!(trashable_paths(&[s(&dir)], &roots, &[]).is_err(), "a picked root itself");
        assert!(trashable_paths(&[s(&dir.join("inner"))], &roots, &[dir.join("inner")]).is_err(), "the destination");
        std::fs::create_dir_all(dir.join("outer/dest")).unwrap();
        assert!(trashable_paths(&[s(&dir.join("outer"))], &roots, &[dir.join("outer/dest")]).is_err(), "a parent of the destination");
        assert!(trashable_paths(&[s(&dir.join("outer/dest"))], &roots, &[dir.join("inner")]).is_ok(), "an unrelated folder is fine");
        if let Some(home) = dirs::home_dir() {
            assert!(trashable_paths(&[s(&home)], &[], &[]).is_err(), "home");
            let documents = home.join("Documents");
            if documents.is_dir() {
                assert!(trashable_paths(&[s(&documents)], &[], &[]).is_err(), "~/Documents");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn walk_storage_counts_files_and_stops_at_the_depth_limit() {
        let root = std::env::temp_dir().join(format!("prism-storage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("one.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(root.join("a/two.bin"), vec![0u8; 250]).unwrap();
        std::fs::write(root.join("a/b/three.bin"), vec![0u8; 650]).unwrap();

        let (files, bytes, partial) = walk_storage(&root);
        assert_eq!(files, 3, "every file under the root is counted");
        assert_eq!(bytes, 1000, "sizes add up across subfolders");
        assert!(!partial, "a small tree is counted in full");

        // Deeper than the cap: still counted, but reported as a floor.
        let mut deep = root.join("deep");
        for _ in 0..(STORAGE_WALK_MAX_DEPTH + 2) {
            deep = deep.join("d");
        }
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("buried.bin"), vec![0u8; 10]).unwrap();
        let (_, _, partial_deep) = walk_storage(&root);
        assert!(partial_deep, "a tree deeper than the cap admits it stopped");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_storage_is_empty_for_a_folder_that_isnt_there() {
        let missing = std::env::temp_dir().join("prism-storage-does-not-exist");
        let _ = std::fs::remove_dir_all(&missing);
        assert_eq!(walk_storage(&missing), (0, 0, false));
    }

    /// The argv is asserted, never run: a test that actually put the machine
    /// running it to sleep would be a poor trade for the coverage.
    #[test]
    fn when_done_builds_only_known_commands() {
        for action in ["sleep", "shutdown"] {
            let (program, args) = when_done_command(action).expect("a known action");
            assert!(!program.is_empty(), "{action} needs a program");
            assert!(!args.is_empty(), "{action} needs arguments");
        }
        // Anything else is refused rather than passed along.
        for action in ["reboot", "", "sleep; rm -rf /", "SLEEP"] {
            assert!(when_done_command(action).is_err(), "{action:?} should be refused");
        }
        // Quit is handled in-process, so it is deliberately not a command.
        assert!(when_done_command("quit").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn when_done_uses_the_unprivileged_macos_paths() {
        assert_eq!(
            when_done_command("sleep").unwrap(),
            ("pmset".to_string(), vec!["sleepnow".to_string()])
        );
        let (program, args) = when_done_command("shutdown").unwrap();
        assert_eq!(program, "osascript");
        assert!(args.iter().any(|a| a.contains("shut down")));
    }

    /// S-11: a torrent-controlled name can't break out of Explorer's quoting.
    #[test]
    fn explorer_select_arg_quotes_and_refuses_quotes() {
        assert_eq!(
            explorer_select_arg("C:/Users/me/Downloads/Show, S01 & more").unwrap(),
            "/select,\"C:\\Users\\me\\Downloads\\Show, S01 & more\""
        );
        assert!(explorer_select_arg("C:/x\" /root,C:/Windows").is_err());
    }

    #[test]
    fn allowed_dirs_file_uses_the_new_identifier() {
        if let Some(f) = picked_dirs_file() {
            assert!(f.to_string_lossy().ends_with("com.rainacorp.prism.allowed-dirs.json"));
        }
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], migrate::NEW_ID);
        // Tauri's NSIS installer names its registry keys after the publisher,
        // or the identifier's second segment when unset — "prism" under
        // com.prism.app. Pinning it keeps Windows upgrades in place.
        assert_eq!(conf["bundle"]["publisher"], "prism");
    }

    /// S-1/S-2: the webview must not be able to write where Rust keeps state
    /// it trusts (torrent-session/session.json is re-added with overwrite at
    /// startup; engine/yt-dlp is executed). Scope globs match with
    /// `require_literal_separator`, so `$APPDATA/*.json` stays top-level.
    #[test]
    fn main_window_fs_access_is_top_level_json_only() {
        let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities/default.json")).unwrap();
        let cap: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let allowed_paths = ["$APPDATA/*.json", "$APPDATA/*.json.tmp"];
        for perm in cap["permissions"].as_array().unwrap() {
            if let Some(id) = perm.as_str() {
                assert!(
                    !id.starts_with("fs:") || id == "fs:deny-default",
                    "unscoped fs permission {id} (global scopes merge into every fs command)"
                );
                assert!(!id.starts_with("updater:"), "updates run through check_app_update");
                continue;
            }
            let id = perm["identifier"].as_str().unwrap();
            if !id.starts_with("fs:") {
                continue;
            }
            assert!(!id.contains("recursive") && !id.contains("appdata"), "{id}");
            for entry in perm["allow"].as_array().unwrap() {
                let p = entry["path"].as_str().unwrap();
                assert!(allowed_paths.contains(&p), "{id} allows {p}");
            }
        }
    }

    /// S-1/S-2 end to end: the real `capabilities/default.json`, enforced by
    /// Tauri's IPC + ACL (mock runtime), decides what the main window may
    /// write through the fs plugin. This resolves to the real app data
    /// directory, so every name is unique to the run and removed afterwards.
    #[test]
    fn webview_fs_access_is_enforced_by_the_real_capability() {
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::webview::InvokeRequest;

        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_fs::init())
            .build(tauri::generate_context!(test = true))
            .expect("mock app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("main webview");
        let data_dir = app.path().app_data_dir().unwrap();
        std::fs::create_dir_all(data_dir.join("torrent-session")).unwrap();
        std::fs::create_dir_all(data_dir.join("engine")).unwrap();
        let tag = format!("prism-acl-test-{}", std::process::id());

        let write = |rel: &str| {
            let mut headers = tauri::http::HeaderMap::new();
            headers.insert("path", rel.parse().unwrap());
            // 14 = BaseDirectory::AppData, as the frontend's writeJson sends it.
            headers.insert("options", r#"{"baseDir":14}"#.parse().unwrap());
            let response = tauri::test::get_ipc_response(
                &webview,
                InvokeRequest {
                    cmd: "plugin:fs|write_text_file".into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: InvokeBody::Raw(b"{}".to_vec()),
                    headers,
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            );
            let _ = std::fs::remove_file(data_dir.join(rel));
            response
        };

        let allowed = format!("{tag}.json.tmp");
        let r = write(&allowed);
        assert!(r.is_ok(), "the settings write-then-rename temp file was refused: {r:?}");

        for refused in [
            format!("torrent-session/{tag}.json"),
            format!("engine/{tag}"),
            format!("{tag}.json"),
            format!("{tag}.sh"),
        ] {
            assert!(write(&refused).is_err(), "the webview could write {refused}");
        }

        // Saves keep the previous copy as `<name>.bak.json` and a damaged file
        // is set aside as `<name>.corrupt-<time>.json` (src/lib/json-store.ts):
        // renames between top-level JSON names must work, and nothing else.
        let rename = |from: &str, to: &str| {
            std::fs::write(data_dir.join(from), b"{}").unwrap();
            let response = tauri::test::get_ipc_response(
                &webview,
                InvokeRequest {
                    cmd: "plugin:fs|rename".into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: InvokeBody::Json(serde_json::json!({
                        "oldPath": from,
                        "newPath": to,
                        "options": { "oldPathBaseDir": 14, "newPathBaseDir": 14 },
                    })),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            );
            for f in [from, to] {
                let _ = std::fs::remove_file(data_dir.join(f));
            }
            response
        };
        let r = rename(&format!("{tag}.json"), &format!("{tag}.bak.json"));
        assert!(r.is_ok(), "keeping a backup copy was refused: {r:?}");
        let r = rename(&format!("{tag}.json"), &format!("{tag}.corrupt-2026-09-26T10-00-00-000Z.json"));
        assert!(r.is_ok(), "setting a damaged file aside was refused: {r:?}");
        assert!(
            rename(&format!("{tag}.json"), &format!("engine/{tag}")).is_err(),
            "the webview could move a file into engine/"
        );
    }

    /// The commands `generate_handler!` registers, read from this file.
    fn registered_commands() -> Vec<String> {
        let src = include_str!("lib.rs");
        let start = src.find(".invoke_handler(tauri::generate_handler![").expect("generate_handler");
        let body = &src[start..];
        let body = &body[body.find('[').unwrap() + 1..body.find("])").unwrap()];
        body.split(',')
            .map(|c| c.trim().rsplit("::").next().unwrap().to_string())
            .filter(|c| !c.is_empty())
            .collect()
    }

    fn capability(name: &str) -> Vec<String> {
        let raw = std::fs::read_to_string(format!("{}/capabilities/{name}.json", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let cap: serde_json::Value = serde_json::from_str(&raw).unwrap();
        cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str().or_else(|| p["identifier"].as_str()).map(str::to_string))
            .collect()
    }

    /// S-2: every command is declared in build.rs's app manifest, and each
    /// window is granted exactly its own. The player window gets its
    /// player_* commands and nothing that could add a download or touch a
    /// file, and it can't emit events the main window trusts.
    #[test]
    fn every_command_is_declared_and_granted_to_the_right_window() {
        const PLAYER_ONLY: &[&str] = &[
            "fixup_player_video", "player_init", "player_destroy", "player_load", "player_load_stream",
            "player_save_position", "player_resume_position", "player_add_subtitle", "player_open_file",
            "player_sibling_subtitles", "player_set_mini", "player_seek", "player_set",
        ];
        let build = include_str!("../build.rs");
        let (main, player) = (capability("default"), capability("player"));
        let allow = |c: &str| format!("allow-{}", c.replace('_', "-"));
        let registered = registered_commands();
        assert!(registered.len() > 40, "parsed the handler list");
        for command in &registered {
            assert!(build.contains(&format!("\"{command}\"")), "{command} is missing from build.rs COMMANDS");
            let only_player = PLAYER_ONLY.contains(&command.as_str());
            assert_eq!(main.contains(&allow(command)), !only_player, "main window and {command}");
            assert_eq!(player.contains(&allow(command)), only_player, "player window and {command}");
        }
        for id in &player {
            assert!(
                !matches!(id.as_str(), "core:default" | "core:event:default" | "core:event:allow-emit" | "core:event:allow-emit-to"),
                "the player window may not emit events ({id})"
            );
        }
    }

    /// S-2 end to end: Tauri's ACL (mock runtime, the real capabilities)
    /// refuses a Prism command the player window isn't granted.
    #[test]
    fn the_player_window_cannot_call_main_window_commands() {
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::webview::InvokeRequest;

        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![get_app_version])
            .build(tauri::generate_context!(test = true))
            .expect("mock app");
        let call = |label: &str, cmd: &str| {
            let webview = tauri::WebviewWindowBuilder::new(&app, label, Default::default()).build().expect("webview");
            let response = tauri::test::get_ipc_response(
                &webview,
                InvokeRequest {
                    cmd: cmd.into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: InvokeBody::default(),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            );
            let _ = webview.close();
            response
        };
        assert!(call("main", "get_app_version").is_ok(), "granted to main");
        let refused = format!("{:?}", call("player", "get_app_version"));
        assert!(refused.contains("not allowed on window"), "the player window called a main-window command: {refused}");
    }

    #[test]
    fn media_key_names_the_video_not_the_url() {
        assert_eq!(media_key(Some("Vimeo"), Some("76979871")).as_deref(), Some("vimeo:76979871"));
        assert_eq!(media_key(Some("Vimeo"), Some("")), None);
        // Seen with the bundled yt-dlp: a plain file's id is its name.
        assert_eq!(media_key(Some("Generic"), Some("stream")), None);
        assert_eq!(media_key(None, Some("x")), None);
        // yt-dlp's JSON carries both fields.
        let info: YtDlpInfo = serde_json::from_str(r#"{"id":"abc","extractor_key":"Twitch","title":"t"}"#).unwrap();
        assert_eq!(media_key(info.extractor_key.as_deref(), info.id.as_deref()).as_deref(), Some("twitch:abc"));
    }

    /// P-3: the command takes a raw body and a name header, and refuses the
    /// old JSON-array shape rather than misreading it.
    #[test]
    fn a_dropped_torrent_arrives_as_raw_bytes() {
        use tauri::ipc::InvokeBody;
        let mut headers = tauri::http::HeaderMap::new();
        headers.insert(TORRENT_NAME_HEADER, "My%20Show%20%E6%97%A5.torrent".parse().unwrap());
        let raw = InvokeBody::Raw(b"d4:infoe".to_vec());
        let (name, bytes) = torrent_upload(&raw, &headers).unwrap();
        assert_eq!(name, "My Show 日.torrent");
        assert_eq!(bytes, b"d4:infoe");

        let json = InvokeBody::Json(serde_json::json!({ "bytes": [1, 2, 3] }));
        assert!(torrent_upload(&json, &headers).is_err());
        let (unnamed, _) = torrent_upload(&raw, &tauri::http::HeaderMap::new()).unwrap();
        assert_eq!(unnamed, "dropped.torrent");
    }

    #[test]
    fn dropped_torrent_names_survive_the_header() {
        // What encodeURIComponent makes of a name with spaces, a plus and
        // non-ASCII characters.
        assert_eq!(decode_header_name("Some%20Show%20%2B%20Extras%20%E6%97%A5%E6%9C%AC.torrent"), "Some Show + Extras 日本.torrent");
        assert_eq!(decode_header_name("plain.torrent"), "plain.torrent");
    }

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
        // A folder inside home is fine; a dotfile directly in it is not.
        assert!(validate_download_path("~/Movies/clip.%(ext)s", &[]).is_ok());
        // Regression (REVIEW 2026-09-26 H1): nor is home itself, where a
        // torrent's own file name would sit beside the shell's startup files.
        assert!(validate_download_path("~", &[]).is_err());
        assert!(validate_download_path("~/", &[]).is_err());
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

    // Regression (REVIEW 2026-09-26 L3): system trees and PATH directories
    // never become download roots, and PATH directories inside home are
    // refused as destinations too.
    #[cfg(unix)]
    #[test]
    fn system_and_program_folders_are_never_roots() {
        use std::path::Path;
        let path_dirs = vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/Users/u/go/bin"), PathBuf::from("/"), PathBuf::from("/Users/u")];
        let home = Some(Path::new("/Users/u"));
        for bad in ["/", "/usr/local", "/usr/local/bin", "/Applications", "/System/Library", "/opt/homebrew"] {
            assert!(system_location(Path::new(bad), &path_dirs, home).is_some(), "{bad} must be refused");
        }
        assert!(program_dir_containing(Path::new("/Users/u/go/bin/ls"), &path_dirs, home).is_some());
        // `/` and home on PATH mean nothing: they'd refuse everything.
        for ok in ["/Volumes/Media/Films", "/Users/u/Movies", "/mnt/nas/dl"] {
            assert!(system_location(Path::new(ok), &path_dirs, home).is_none(), "{ok} must be allowed");
        }
    }

    /// S-9: the deny-list is pure path logic, so pin each platform's rules
    /// on synthetic paths (nothing needs to exist).
    #[test]
    fn deny_list_platform_rules() {
        use std::path::Path;
        #[cfg(target_os = "macos")]
        {
            let home = Path::new("/Users/u");
            for bad in ["/Users/u/Library/LaunchAgents/x.plist", "/Users/u/library/LaunchAgents/x", "/Users/u/LIBRARY", "/users/U/Library/x", "/Users/u/.SSH/x"] {
                assert!(denied_subtree(Path::new(bad), home).is_some(), "{bad} must be denied");
            }
            for ok in ["/Users/u/Movies/x.mp4", "/Users/u/Libraryish/x", "/Users/other/Library/x"] {
                assert!(denied_subtree(Path::new(ok), home).is_none(), "{ok} must be allowed");
            }
            assert!(strip_prefix_fs(Path::new("/users/U/Downloads/x"), Path::new("/Users/u")).is_some());
        }
        #[cfg(target_os = "windows")]
        {
            let home = Path::new(r"C:\Users\u");
            assert!(denied_subtree(Path::new(r"c:\users\u\appdata\Roaming\x"), home).is_some());
            assert!(denied_subtree(Path::new(r"C:\Users\u\Videos\x.mp4"), home).is_none());
        }
        #[cfg(target_os = "linux")]
        {
            let home = Path::new("/home/u");
            for bad in ["/home/u/bin/evil", "/home/u/Desktop/run.desktop", "/home/u/Desktop/RUN.DESKTOP", "/home/u/.local/bin/x"] {
                assert!(denied_subtree(Path::new(bad), home).is_some(), "{bad} must be denied");
            }
            // Case-sensitive filesystem: ~/BIN is a different folder.
            for ok in ["/home/u/BIN/x", "/home/u/Desktop/clip.mp4", "/home/u/Desktop/sub/x.desktop", "/home/u/Library/x"] {
                assert!(denied_subtree(Path::new(ok), home).is_none(), "{ok} must be allowed");
            }
            assert!(strip_prefix_fs(Path::new("/HOME/u/x"), home).is_none());
        }
    }

    #[test]
    fn capture_stderr_keeps_only_the_tail() {
        let mut buf = Vec::new();
        push_tail(&mut buf, b"0123456789", 4);
        assert_eq!(buf, b"6789");
        push_tail(&mut buf, b"ab", 4);
        assert_eq!(buf, b"89ab");
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

    /// `open_file` allowlists by extension. That check has to see the file
    /// the OS will actually open: a symlink named `clip.mp4` pointing at a
    /// `.command` used to pass as media and then run as the `.command`.
    #[cfg(unix)]
    #[test]
    fn open_path_resolves_symlinks_before_the_media_check() {
        let dir = std::env::temp_dir().join(format!("prism-symlink-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let payload = dir.join("payload.command");
        std::fs::write(&payload, b"#!/bin/sh\n").unwrap();
        let link = dir.join("clip.mp4");
        std::os::unix::fs::symlink(&payload, &link).unwrap();

        let validated = validate_open_path(&link.to_string_lossy(), false, std::slice::from_ref(&dir)).unwrap();
        assert!(validated.ends_with("payload.command"), "got {validated}");
        assert!(!is_openable_media(&validated));

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

    /// A dropped .torrent comes back as a magnet whose hash is the one the
    /// cache lookup (`with_cached_metadata`) will find it under.
    #[test]
    fn dropped_torrent_bytes_become_a_matching_magnet() {
        let mut bytes = b"d4:infod6:lengthi3e4:name10:clip &.mp412:piece lengthi16384e6:pieces20:".to_vec();
        bytes.extend_from_slice(&[0u8; 20]);
        bytes.extend_from_slice(b"ee");
        let (hash, name) = torrent_identity(&bytes).expect("valid torrent");
        assert_eq!(hash.len(), 40);
        assert_eq!(name.as_deref(), Some("clip &.mp4"));
        let magnet = magnet_for(&hash, name.as_deref().unwrap());
        assert_eq!(magnet_info_hash(&magnet).as_deref(), Some(hash.as_str()));
        assert!(magnet.ends_with("&dn=clip+%26.mp4"), "{magnet}");
        assert!(torrent_identity(b"not a torrent").is_none());
    }

    #[test]
    fn magnet_info_hash_and_trackers_are_parsed() {
        let m = "magnet:?xt=urn:btih:C12FE1C06BBA254A9DC9F519B335AA7C1367A88A&dn=x&tr=udp%3A%2F%2Ftracker.example%3A1337%2Fannounce&tr=https%3A%2F%2Ft.example%2Fa&tr=ftp%3A%2F%2Fnope";
        assert_eq!(magnet_info_hash(m).as_deref(), Some("c12fe1c06bba254a9dc9f519b335aa7c1367a88a"));
        assert_eq!(
            magnet_trackers(m),
            vec!["udp://tracker.example:1337/announce".to_string(), "https://t.example/a".to_string()]
        );
        // base32 form of the same hash
        let b32 = "magnet:?xt=urn:btih:YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK";
        assert_eq!(magnet_info_hash(b32).as_deref(), Some("c12fe1c06bba254a9dc9f519b335aa7c1367a88a"));
        assert_eq!(magnet_info_hash("magnet:?dn=nohash"), None);
        assert_eq!(magnet_info_hash("https://example.com/x.torrent"), None);
        assert!(magnet_trackers("not a magnet").is_empty());
    }

    // Regression (REVIEW 2026-09-26 L7): an edit that keeps the file's size
    // is seen at once, whatever the modification time says.
    #[test]
    fn a_same_length_settings_edit_is_not_read_stale() {
        let dir = std::env::temp_dir().join(format!("prism-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, r#"{"cookiesFromBrowser":"safari"}"#).unwrap();
        let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(settings_snapshot(&path).unwrap()["cookiesFromBrowser"], "safari");
        std::fs::write(&path, r#"{"cookiesFromBrowser":"chrome"}"#).unwrap();
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(mtime).unwrap();
        assert_eq!(settings_snapshot(&path).unwrap()["cookiesFromBrowser"], "chrome");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn crash_report_text_is_scrubbed() {
        let s = scrub_text("failed https://youtube.com/watch?v=abc at /Users/me/Downloads/x.mp4 and C:\\Users\\me\\x");
        assert!(!s.contains("youtube.com"), "{s}");
        assert!(!s.contains("/Users/me"), "{s}");
        assert!(!s.contains("C:\\Users\\me"), "{s}");
        assert!(s.contains("[url]") && s.contains("[path]"), "{s}");
        assert_eq!(scrub_text("plain panic message"), "plain panic message");
        // Regression (REVIEW 2026-09-26 L1): other drives, mounts and shares too.
        for path in [
            "/Volumes/Media/Films/Secret Title.mkv",
            "D:\\Films\\Secret Title.mkv",
            "\\\\nas\\share\\Secret Title.mkv",
            "/mnt/nas/Secret Title.mkv",
            "~/Downloads/Secret Title.mkv",
            "/private/var/folders/x/Secret Title.mkv",
        ] {
            let s = scrub_text(&format!("could not open {path}"));
            assert!(!s.contains("Secret") && !s.contains("Title"), "{path} → {s}");
        }
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

    /// Integration: the bundled yt-dlp (onedir, staged by
    /// scripts/fetch-sidecars.sh into src-tauri/ytdlp) actually executes.
    /// Skips (rather than fails) on a fresh clone before it is fetched.
    #[test]
    fn bundled_ytdlp_runs() {
        let bin = engine::bundled_ytdlp_in(std::path::Path::new(env!("CARGO_MANIFEST_DIR")));
        if !bin.exists() {
            eprintln!("skipping: yt-dlp not staged at {:?}", bin);
            return;
        }
        let out = std::process::Command::new(&bin)
            .args(["--ignore-config", "--version"])
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

        // The point of the onedir build (REVIEW 2026-09-26): once its files
        // have been seen, a start takes a fraction of a second, where the
        // one-file build unpacked itself and took ~5 s on every run. Timed on
        // the run after the one above, which pays macOS's one-time scan.
        if bin.parent().is_some_and(|d| d.join("_internal").is_dir()) && cfg!(target_os = "macos") {
            let started = std::time::Instant::now();
            let out = std::process::Command::new(&bin).args(["--ignore-config", "--version"]).output().unwrap();
            assert!(out.status.success());
            let took = started.elapsed();
            assert!(took < std::time::Duration::from_secs(2), "yt-dlp took {took:?} to start");
        }
    }
}
