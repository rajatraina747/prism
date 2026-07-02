use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use regex::Regex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::process::CommandEvent;
use tokio::sync::Mutex;

use crate::find_ffmpeg;

static PCT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+\.?\d*)%").unwrap());
static SIZE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"of\s+~?\s*([\d.]+)([KMG]i?B)").unwrap());
static SPEED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"at\s+([\d.]+)([KMG]i?B)/s").unwrap());
static ETA_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"ETA\s+(?:(\d+):)?(\d+):(\d+)").unwrap());

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

    #[allow(clippy::too_many_arguments)]
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
                    args.push("bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[vcodec^=avc1]/bestvideo+bestaudio/best".into());
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
                    // Pass raw bytes/sec — dividing to KiB truncates limits under
                    // 1024 B/s to an invalid "0K"
                    args.push("--limit-rate".into());
                    args.push(limit.to_string());
                }
            }

            // Resume partial (.part) files from a previous paused/cancelled run.
            // The frontend reuses the same output template per queue item, so a
            // killed download picks up where it left off instead of restarting.
            args.push("--continue".into());

            // Fail fast on dead connections (default socket timeout is 20s but
            // stalls can still sit under the app's 5-minute inactivity kill),
            // and be generous retrying individual HLS/DASH fragments.
            args.push("--socket-timeout".into());
            args.push("30".into());
            args.push("--retries".into());
            args.push("10".into());
            args.push("--fragment-retries".into());
            args.push("10".into());

            args.push("--force-ipv4".into());

            if let Some(browser) = crate::cookies_browser(&app) {
                args.push("--cookies-from-browser".into());
                args.push(browser);
            }

            // Tell yt-dlp where ffmpeg is — Finder-launched apps may not have it in PATH
            let ffmpeg = find_ffmpeg();
            if let Some(ref ffmpeg_path) = ffmpeg {
                args.push("--ffmpeg-location".into());
                args.push(ffmpeg_path.clone());
            }

            // Embed cover art, tags, and chapter markers so files look right in
            // Finder and media players. Gated on ffmpeg: these postprocessors
            // fail the whole download when it's missing.
            if ffmpeg.is_some() {
                args.push("--embed-thumbnail".into());
                args.push("--embed-metadata".into());
                if !audio_only {
                    args.push("--embed-chapters".into());
                }
            }

            let cmd = match crate::engine::ytdlp_command(&app) {
                Ok(c) => c.args(&args),
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

            let mut success = false;
            let mut last_error = String::new();

            loop {
                match tokio::time::timeout(std::time::Duration::from_secs(300), rx.recv()).await {
                    Ok(Some(event)) => match event {
                        CommandEvent::Stdout(data) => {
                            let line = String::from_utf8_lossy(&data);
                            if let Some(p) = parse_progress(&line, &PCT_RE, &SIZE_RE, &SPEED_RE, &ETA_RE, &id) {
                                let _ = app.emit(&format!("download-progress-{}", id), p);
                            }
                        }
                        CommandEvent::Stderr(data) => {
                            let line = String::from_utf8_lossy(&data);
                            let trimmed = line.trim();
                            if !trimmed.is_empty() {
                                last_error = trimmed.to_string();
                            }
                            if let Some(p) = parse_progress(&line, &PCT_RE, &SIZE_RE, &SPEED_RE, &ETA_RE, &id) {
                                let _ = app.emit(&format!("download-progress-{}", id), p);
                            }
                        }
                        CommandEvent::Terminated(payload) => {
                            success = payload.code == Some(0);
                            break;
                        }
                        _ => {}
                    },
                    Ok(None) => break,
                    Err(_) => {
                        // 5-minute inactivity timeout
                        let mut map = downloads.lock().await;
                        if let Some(dl) = map.remove(&id) {
                            let _ = dl.child.kill();
                        }
                        last_error = "Download timed out (no activity for 5 minutes)".to_string();
                        break;
                    }
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
                        Some(if last_error.is_empty() { "Download failed or was cancelled".into() } else { last_error })
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
            let hours: f64 = c.get(1).map_or("0", |m| m.as_str()).parse().ok()?;
            let mins: f64 = c.get(2)?.as_str().parse().ok()?;
            let secs: f64 = c.get(3)?.as_str().parse().ok()?;
            Some(hours * 3600.0 + mins * 60.0 + secs)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_progress_template_line() {
        let line = " 45.2% of ~ 120.50MiB at 2.5MiB/s ETA 01:23";
        let p = parse_progress(line, &PCT_RE, &SIZE_RE, &SPEED_RE, &ETA_RE, "test-id").unwrap();
        assert_eq!(p.id, "test-id");
        assert!((p.progress - 45.2).abs() < f64::EPSILON);
        assert_eq!(p.total_bytes, (120.5 * 1024.0 * 1024.0) as u64);
        assert_eq!(p.speed, 2.5 * 1024.0 * 1024.0);
        assert_eq!(p.eta, 83.0);
        assert_eq!(p.downloaded_bytes, (0.452 * 120.5 * 1024.0 * 1024.0) as u64);
    }

    #[test]
    fn parses_eta_with_hours() {
        let line = " 12.0% of ~ 4.20GiB at 1.0MiB/s ETA 1:02:33";
        let p = parse_progress(line, &PCT_RE, &SIZE_RE, &SPEED_RE, &ETA_RE, "x").unwrap();
        assert_eq!(p.eta, 3600.0 + 2.0 * 60.0 + 33.0);
    }

    #[test]
    fn ignores_lines_without_percent() {
        assert!(parse_progress("[download] Destination: video.mp4", &PCT_RE, &SIZE_RE, &SPEED_RE, &ETA_RE, "x").is_none());
    }

    #[test]
    fn parses_sizes_by_unit() {
        assert_eq!(parse_size(1.0, "KiB"), 1024);
        assert_eq!(parse_size(1.0, "MiB"), 1024 * 1024);
        assert_eq!(parse_size(2.0, "GiB"), 2 * 1024 * 1024 * 1024);
        assert_eq!(parse_size(5.0, "??"), 5);
    }

    #[test]
    fn finds_output_file_by_extension() {
        let dir = std::env::temp_dir().join(format!("prism-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let template = dir.join("clip.%(ext)s").to_string_lossy().into_owned();
        assert_eq!(find_output_file(&template), None);
        let mp4 = dir.join("clip.mp4");
        std::fs::write(&mp4, b"x").unwrap();
        assert_eq!(find_output_file(&template), Some(mp4.to_string_lossy().into_owned()));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
