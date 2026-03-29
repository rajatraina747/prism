mod download_manager;

use std::path::PathBuf;

use download_manager::DownloadManager;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

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
    parse_args.push(url.clone());

    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("Failed to find yt-dlp sidecar: {}", e))?
        .env("PATH", augmented_path())
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
async fn parse_playlist(app: AppHandle, url: String) -> Result<PlaylistInfo, String> {
    let mut playlist_args: Vec<String> = vec![
        "--flat-playlist".into(),
        "--dump-json".into(),
        "--no-download".into(),
        "--no-warnings".into(),
        "--force-ipv4".into(),
    ];
    playlist_args.push(url.clone());

    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("Failed to find yt-dlp sidecar: {}", e))?
        .env("PATH", augmented_path())
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
) -> Result<(), String> {
    let expanded_path = validate_download_path(&output_path)?;
    // Auto-number if the target .mp4 already exists
    let deduped_path = dedupe_output_path(&expanded_path);
    // Ensure the parent directory exists
    if let Some(parent) = PathBuf::from(&deduped_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create download directory: {}", e))?;
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
async fn open_file(path: String) -> Result<(), String> {
    let expanded = expand_tilde(&path);
    opener::open(&expanded).map_err(|e| format!("Failed to open file: {}", e))
}

#[tauri::command]
async fn show_in_folder(path: String) -> Result<(), String> {
    let expanded = expand_tilde(&path);
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

    // Reject paths with traversal components
    if expanded.contains("..") {
        return Err("Invalid download path: directory traversal not allowed".into());
    }

    // Verify path is under home, downloads, or appdata
    let path_buf = PathBuf::from(&expanded);
    let allowed = [
        dirs::home_dir(),
        dirs::download_dir(),
        dirs::data_dir(),
    ];
    let is_allowed = allowed.iter().any(|base| {
        base.as_ref().map_or(false, |b| path_buf.starts_with(b))
    });

    if !is_allowed {
        return Err(format!("Download path must be within your home directory: {}", expanded));
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

/// Given an output path like `/path/to/video.%(ext)s`, check if
/// `video.mp4` already exists. If so, try `video (1).%(ext)s`, `video (2).%(ext)s`, etc.
fn dedupe_output_path(template: &str) -> String {
    // The template ends with .%(ext)s — check the .mp4 version for existence
    let mp4_path = template.replace(".%(ext)s", ".mp4");
    if !std::path::Path::new(&mp4_path).exists() {
        return template.to_string();
    }

    // Strip the .%(ext)s suffix to get the base
    let base = template.trim_end_matches(".%(ext)s");

    for n in 1..1000 {
        let candidate_mp4 = format!("{} ({}).mp4", base, n);
        if !std::path::Path::new(&candidate_mp4).exists() {
            return format!("{} ({}).%(ext)s", base, n);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DownloadManager::new())
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            parse_url,
            parse_playlist,
            start_download,
            cancel_download,
            open_file,
            show_in_folder,
            get_default_download_path,
            get_app_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
