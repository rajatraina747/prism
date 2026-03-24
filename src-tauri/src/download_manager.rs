use std::collections::HashMap;
use std::sync::Arc;

use regex::Regex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

use crate::{augmented_path, find_ffmpeg};

#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    pub id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub progress: f64,
    pub speed: f64,
    pub eta: f64,
}

#[derive(Clone, Serialize)]
pub struct DownloadComplete {
    pub id: String,
    pub success: bool,
    pub error: Option<String>,
    pub file_path: Option<String>,
    pub file_size: Option<u64>,
}

struct ActiveDownload {
    child: CommandChild,
}

pub struct DownloadManager {
    downloads: Arc<Mutex<HashMap<String, ActiveDownload>>>,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            downloads: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn start_download(
        &self,
        app: AppHandle,
        id: String,
        url: String,
        output_path: String,
        format_id: Option<String>,
        audio_only: bool,
        download_subtitles: bool,
        subtitle_language: Option<String>,
        speed_limit: Option<u64>,
    ) {
        let downloads = self.downloads.clone();

        tauri::async_runtime::spawn(async move {
            let mut args = vec![
                url.clone(),
                "-o".into(),
                output_path.clone(),
                "--newline".into(),
                "--progress".into(),
                "--progress-template".into(),
                "%(progress._percent_str)s of %(progress._total_bytes_str)s at %(progress._speed_str)s ETA %(progress._eta_str)s".into(),
            ];

            if audio_only {
                // Audio-only: extract audio as mp3
                args.push("--extract-audio".into());
                args.push("--audio-format".into());
                args.push("mp3".into());
                args.push("--audio-quality".into());
                args.push("0".into());
            } else {
                // Video: merge to mp4
                args.push("--merge-output-format".into());
                args.push("mp4".into());
                args.push("--remux-video".into());
                args.push("mp4".into());

                if let Some(ref fmt) = format_id {
                    args.push("-f".into());
                    args.push(fmt.clone());
                } else {
                    args.push("-f".into());
                    args.push("bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo+bestaudio/best".into());
                }
                // Prefer H.264/AAC for QuickTime compatibility
                args.push("-S".into());
                args.push("vcodec:h264,acodec:m4a".into());
            }

            if download_subtitles {
                args.push("--write-subs".into());
                args.push("--write-auto-subs".into());
                let lang = subtitle_language.as_deref().unwrap_or("en");
                args.push("--sub-lang".into());
                args.push(lang.into());
                args.push("--sub-format".into());
                args.push("srt/vtt/best".into());
            }

            if let Some(limit) = speed_limit {
                if limit > 0 {
                    args.push("--limit-rate".into());
                    args.push(format!("{}K", limit / 1024));
                }
            }

            args.push("--force-ipv4".into());

            // Tell yt-dlp where ffmpeg is — Finder-launched apps may not have it in PATH
            if let Some(ffmpeg_path) = find_ffmpeg() {
                args.push("--ffmpeg-location".into());
                args.push(ffmpeg_path);
            }

            let cmd = match app.shell().sidecar("yt-dlp") {
                Ok(c) => c.env("PATH", augmented_path()).args(&args),
                Err(e) => {
                    let _ = app.emit(
                        &format!("download-complete-{}", id),
                        DownloadComplete {
                            id,
                            success: false,
                            error: Some(format!("Failed to find yt-dlp sidecar: {}", e)),
                            file_path: None,
                            file_size: None,
                        },
                    );
                    return;
                }
            };

            let (mut rx, child) = match cmd.spawn() {
                Ok(pair) => pair,
                Err(e) => {
                    let _ = app.emit(
                        &format!("download-complete-{}", id),
                        DownloadComplete {
                            id,
                            success: false,
                            error: Some(format!("Failed to start yt-dlp: {}", e)),
                            file_path: None,
                            file_size: None,
                        },
                    );
                    return;
                }
            };

            {
                let mut map = downloads.lock().await;
                map.insert(id.clone(), ActiveDownload { child });
            }

            let pct_re = Regex::new(r"(\d+\.?\d*)%").unwrap();
            let size_re = Regex::new(r"of\s+~?\s*([\d.]+)([KMG]i?B)").unwrap();
            let speed_re = Regex::new(r"at\s+([\d.]+)([KMG]i?B)/s").unwrap();
            let eta_re = Regex::new(r"ETA\s+(\d+):(\d+)").unwrap();

            let mut success = false;

            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(data) | CommandEvent::Stderr(data) => {
                        let line = String::from_utf8_lossy(&data);
                        if let Some(p) = parse_progress(&line, &pct_re, &size_re, &speed_re, &eta_re, &id) {
                            let _ = app.emit(&format!("download-progress-{}", id), p);
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        success = payload.code == Some(0);
                    }
                    _ => {}
                }
            }

            // Remove from active downloads
            {
                let mut map = downloads.lock().await;
                map.remove(&id);
            }

            let final_path = if success {
                find_output_file(&output_path)
            } else {
                None
            };

            let file_size = final_path.as_ref().and_then(|p| {
                std::fs::metadata(p).ok().map(|m| m.len())
            });

            let _ = app.emit(
                &format!("download-complete-{}", id),
                DownloadComplete {
                    id,
                    success,
                    error: if success {
                        None
                    } else {
                        Some("Download failed or was cancelled".into())
                    },
                    file_path: final_path,
                    file_size,
                },
            );
        });
    }

    pub async fn cancel_download(&self, id: &str) -> bool {
        let mut map = self.downloads.lock().await;
        if let Some(dl) = map.remove(id) {
            let _ = dl.child.kill();
            true
        } else {
            false
        }
    }
}

fn parse_progress(
    line: &str,
    pct_re: &Regex,
    size_re: &Regex,
    speed_re: &Regex,
    eta_re: &Regex,
    id: &str,
) -> Option<DownloadProgress> {
    let pct = pct_re
        .captures(line)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<f64>().ok())?;

    let total_bytes = size_re
        .captures(line)
        .and_then(|c| {
            let val: f64 = c.get(1)?.as_str().parse().ok()?;
            let unit = c.get(2)?.as_str();
            Some(parse_size(val, unit))
        })
        .unwrap_or(0);

    let speed = speed_re
        .captures(line)
        .and_then(|c| {
            let val: f64 = c.get(1)?.as_str().parse().ok()?;
            let unit = c.get(2)?.as_str();
            Some(parse_size(val, unit) as f64)
        })
        .unwrap_or(0.0);

    let eta = eta_re
        .captures(line)
        .and_then(|c| {
            let mins: f64 = c.get(1)?.as_str().parse().ok()?;
            let secs: f64 = c.get(2)?.as_str().parse().ok()?;
            Some(mins * 60.0 + secs)
        })
        .unwrap_or(0.0);

    let downloaded = (pct / 100.0 * total_bytes as f64) as u64;

    Some(DownloadProgress {
        id: id.to_string(),
        downloaded_bytes: downloaded,
        total_bytes,
        progress: pct,
        speed,
        eta,
    })
}

fn parse_size(val: f64, unit: &str) -> u64 {
    let multiplier = match unit {
        "KiB" | "KB" => 1024.0,
        "MiB" | "MB" => 1024.0 * 1024.0,
        "GiB" | "GB" => 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    (val * multiplier) as u64
}

/// Given an output template like `/path/to/video.%(ext)s`, find the actual
/// file on disk. Tries .mp4 first (most common due to --merge-output-format
/// and --remux-video), then falls back to other common extensions.
fn find_output_file(template: &str) -> Option<String> {
    let extensions = ["mp4", "mkv", "webm", "mov", "avi", "flv", "mp3", "m4a", "opus", "ogg", "wav"];
    for ext in extensions {
        let candidate = template.replace("%(ext)s", ext);
        if std::path::Path::new(&candidate).exists() {
            return Some(candidate);
        }
    }
    None
}
