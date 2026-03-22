use std::collections::HashMap;
use std::sync::Arc;

use regex::Regex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

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
                "--js-runtimes".into(),
                "node,deno,bun".into(),
                "--merge-output-format".into(),
                "mp4".into(),
            ];

            if let Some(ref fmt) = format_id {
                args.push("-f".into());
                args.push(fmt.clone());
            } else {
                // Default: best video+audio merged
                args.push("-f".into());
                args.push("bestvideo+bestaudio/best".into());
            }

            let cmd = match app.shell().sidecar("yt-dlp") {
                Ok(c) => c.args(&args),
                Err(e) => {
                    let _ = app.emit(
                        &format!("download-complete-{}", id),
                        DownloadComplete {
                            id,
                            success: false,
                            error: Some(format!("Failed to find yt-dlp sidecar: {}", e)),
                            file_path: None,
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
                    file_path: if success {
                        Some(output_path)
                    } else {
                        None
                    },
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
