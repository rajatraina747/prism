use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use regex::Regex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
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
    child: Child,
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
            let sidecar = app
                .path()
                .resolve("binaries/yt-dlp", tauri::path::BaseDirectory::Resource)
                .unwrap_or_else(|_| std::path::PathBuf::from("yt-dlp"));

            let mut cmd = Command::new(&sidecar);
            cmd.arg(&url)
                .arg("-o")
                .arg(&output_path)
                .arg("--newline")
                .arg("--progress")
                .arg("--progress-template")
                .arg("%(progress._percent_str)s %(progress._total_bytes_str)s %(progress._speed_str)s %(progress._eta_str)s")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);

            if let Some(ref fmt) = format_id {
                cmd.arg("-f").arg(fmt);
            }

            let mut child = match cmd.spawn() {
                Ok(c) => c,
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

            let stdout = child.stderr.take();
            {
                let mut map = downloads.lock().await;
                map.insert(id.clone(), ActiveDownload { child });
            }

            if let Some(pipe) = stdout {
                let reader = BufReader::new(pipe);
                let mut lines = reader.lines();
                let pct_re = Regex::new(r"(\d+\.?\d*)%").unwrap();
                let size_re = Regex::new(r"of\s+~?\s*([\d.]+)([KMG]i?B)").unwrap();
                let speed_re = Regex::new(r"at\s+([\d.]+)([KMG]i?B)/s").unwrap();
                let eta_re = Regex::new(r"ETA\s+(\d+):(\d+)").unwrap();

                while let Ok(Some(line)) = lines.next_line().await {
                    let progress = parse_progress(&line, &pct_re, &size_re, &speed_re, &eta_re, &id);
                    if let Some(p) = progress {
                        let _ = app.emit(&format!("download-progress-{}", id), p);
                    }
                }
            }

            let exit_status: Option<std::process::ExitStatus> = {
                let mut map = downloads.lock().await;
                let dl = map.remove(&id);
                match dl {
                    Some(mut d) => d.child.wait().await.ok(),
                    None => None,
                }
            };

            let success = exit_status.map(|s: std::process::ExitStatus| s.success()).unwrap_or(false);
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
        if let Some(mut dl) = map.remove(id) {
            let _ = dl.child.kill().await;
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
