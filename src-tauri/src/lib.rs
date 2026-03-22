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

// ── Commands ─────────────────────────────────────────────────────────

#[tauri::command]
async fn parse_url(app: AppHandle, url: String) -> Result<MediaMetadata, String> {
    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("Failed to find yt-dlp sidecar: {}", e))?
        .args(["--dump-json", "--no-download", "--no-warnings", "--js-runtimes", "node,deno,bun", &url])
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
    let raw_formats = info.formats.unwrap_or_default();
    let mut seen_heights: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    let mut best_size_for_height: std::collections::HashMap<u32, u64> = std::collections::HashMap::new();

    for f in &raw_formats {
        let height = f.height.unwrap_or(0);
        if height < 144 {
            continue; // skip storyboards and tiny thumbnails
        }
        let vcodec = f.vcodec.as_deref().unwrap_or("none");
        if vcodec == "none" {
            continue; // skip audio-only
        }
        let ext = f.ext.as_deref().unwrap_or("");
        if ext == "mhtml" {
            continue; // skip storyboard formats
        }
        seen_heights.insert(height);
        let size = f.filesize.or(f.filesize_approx).unwrap_or(0);
        let entry = best_size_for_height.entry(height).or_insert(0);
        if size > *entry {
            *entry = size;
        }
    }

    // Build format options as resolution choices (yt-dlp will merge video+audio)
    let unique_formats: Vec<FormatOption> = seen_heights
        .into_iter()
        .rev()
        .map(|height| {
            let quality = match height {
                h if h >= 2160 => "best",
                h if h >= 1080 => "high",
                h if h >= 720 => "medium",
                _ => "low",
            };
            let size = best_size_for_height.get(&height).copied().unwrap_or(0);
            FormatOption {
                // Use yt-dlp merge syntax: best video at this height + best audio
                id: format!("bestvideo[height<={}]+bestaudio/best[height<={}]", height, height),
                label: format!("{}p MP4", height),
                resolution: format!("{}p", height),
                container: "mp4".into(),
                codec: "h264/aac".into(),
                file_size: size,
                quality: quality.into(),
            }
        })
        .collect();

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
async fn start_download(
    app: AppHandle,
    id: String,
    url: String,
    output_path: String,
    format_id: Option<String>,
) -> Result<(), String> {
    let expanded_path = expand_tilde(&output_path);
    // Ensure the parent directory exists
    if let Some(parent) = PathBuf::from(&expanded_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let manager = app.state::<DownloadManager>();
    manager.start_download(app.clone(), id, url, expanded_path, format_id);
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
    // On macOS, use `open -R` to reveal the file in Finder (selects it)
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&expanded)
            .spawn()
            .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
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

fn extract_domain(url: &str) -> String {
    url.split("//")
        .nth(1)
        .and_then(|s| s.split('/').next())
        .unwrap_or("unknown")
        .to_string()
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
