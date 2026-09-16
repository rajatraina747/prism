use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use regex::Regex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::errors::{classify_output, ErrorCode, PrismError};
use crate::find_ffmpeg;
use crate::spawn::{Child, Event};

static PCT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+\.?\d*)%").unwrap());
static SIZE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"of\s+~?\s*([\d.]+)([KMG]i?B)").unwrap());
static SPEED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"at\s+([\d.]+)([KMG]i?B)/s").unwrap());
static ETA_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"ETA\s+(?:(\d+):)?(\d+):(\d+)").unwrap());

/// yt-dlp download processes allowed at once (S-8). The UI caps concurrency
/// at 10; this is the backstop against a flood of `start_download` calls, so
/// it refuses rather than queues — a waiting run couldn't be cancelled.
const MAX_CONCURRENT_DOWNLOADS: usize = 16;
static DOWNLOAD_SLOTS: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_DOWNLOADS)));

/// Longest stderr line kept as a failure message.
const MAX_ERROR_LINE: usize = 2000;
/// stderr kept for a failure's detail (the cause is at the end).
const MAX_STDERR_TAIL: usize = 16 * 1024;

fn clip_line(s: &str) -> String {
    match s.char_indices().nth(MAX_ERROR_LINE) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

fn emit_start_failure(app: &AppHandle, id: String, error: PrismError) {
    let _ = app.emit(
        &format!("download-complete-{}", id),
        DownloadComplete {
            id,
            success: false,
            error: Some(error),
            file_path: None,
            file_size: None,
            actual_height: None,
            output_folder: None,
        },
    );
}

#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    pub id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub progress: f64,
    pub speed: f64,
    pub eta: f64,
    /// Set to "processing" once yt-dlp hands off to ffmpeg (merge/extract/
    /// embed); absent while bytes are still coming down.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<&'static str>,
}

#[derive(Clone, Serialize)]
pub struct DownloadComplete {
    pub id: String,
    pub success: bool,
    pub error: Option<PrismError>,
    pub file_path: Option<String>,
    pub file_size: Option<u64>,
    /// Video height actually delivered (yt-dlp's after_move print), so the UI
    /// can flag silent quality degradation against the requested format.
    /// None for audio-only, torrents, and failures.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_height: Option<u32>,
    /// Torrents: the folder the files were written to. A multi-file torrent
    /// gets its own `<destination>/<name>` folder, so the Library needs this
    /// (not the destination) to locate each file. None for yt-dlp downloads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_folder: Option<String>,
}

struct ActiveDownload {
    child: Child,
    /// Cleared when the run is cancelled or superseded. Its reader task checks
    /// this before touching shared state or emitting: a process that outlived
    /// its kill must not keep streaming progress under the item's id.
    alive: Arc<AtomicBool>,
}

impl ActiveDownload {
    /// Kill the whole run, forked worker included — see `crate::spawn` for
    /// why the direct child isn't enough.
    fn kill(self) {
        self.child.kill();
    }

    /// Kill it *and* disown the run, so its reader task goes quiet instead of
    /// competing with whoever owns the id now.
    fn stop(self) {
        self.alive.store(false, Ordering::SeqCst);
        self.kill();
    }
}

pub struct DownloadManager {
    downloads: Arc<Mutex<HashMap<String, ActiveDownload>>>,
    /// Output templates claimed by in-flight downloads (id → template).
    /// Consulted by the dedupe so two concurrent downloads of the same title
    /// never share intermediate files. Entries are removed when the download
    /// ends, so a paused/failed item keeps its template on retry (resuming
    /// its own `.part` files).
    reserved: Arc<Mutex<HashMap<String, String>>>,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            downloads: Arc::new(Mutex::new(HashMap::new())),
            reserved: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn start_download(
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
        let reserved = self.reserved.clone();

        // One live download per item. A run for this id may still be going —
        // a kill that didn't take, or a double start from the frontend — and
        // two processes streaming progress under one id make the UI flicker
        // between them while two copies of the file download in parallel.
        // Superseding also frees the old template claim, so the replacement
        // resumes the same `.part` instead of dedupe-ing to a fresh copy.
        // (Bound the guard to this statement — killing a tree blocks.)
        let superseded = downloads.lock().await.remove(&id);
        if let Some(prev) = superseded {
            prev.stop();
            reserved.lock().await.remove(&id);
        }

        // Auto-number the template against disk AND other active downloads,
        // atomically with claiming it — concurrent adds of the same title
        // must land on distinct templates.
        let output_path = {
            let mut guard = reserved.lock().await;
            let taken: Vec<String> = guard.values().cloned().collect();
            let path = crate::dedupe_output_path(&output_path, &taken);
            guard.insert(id.clone(), path.clone());
            path
        };

        tauri::async_runtime::spawn(async move {
            // URL is appended last (after a `--` terminator) so it can't be
            // parsed as a yt-dlp option — see the note in lib::parse_url.
            let mut args = vec![
                "-o".into(),
                output_path.clone(),
                "--newline".into(),
                "--progress".into(),
                "--progress-template".into(),
                "%(progress._percent_str)s of %(progress._total_bytes_str)s at %(progress._speed_str)s ETA %(progress._eta_str)s".into(),
            ];

            if audio_only {
                // Audio-only: extract to the user's configured format
                args.push("--extract-audio".into());
                args.push("--audio-format".into());
                args.push(crate::audio_format(&app));
                args.push("--audio-quality".into());
                args.push("0".into());
            } else {
                let keep_container = crate::keep_original_container(&app);
                if !keep_container {
                    // Default: everything lands in an .mp4 (QuickTime/Finder
                    // friendly). VP9/AV1 in mp4 trips some players — the
                    // "keep original container" setting skips the remux and
                    // lets yt-dlp pick mkv/webm when the codecs need it.
                    args.push("--merge-output-format".into());
                    args.push("mp4".into());
                    args.push("--remux-video".into());
                    args.push("mp4".into());
                }

                if let Some(ref fmt) = format_id {
                    args.push("-f".into());
                    args.push(fmt.clone());
                } else {
                    args.push("-f".into());
                    args.push("bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[vcodec^=avc1]/bestvideo+bestaudio/best".into());
                }
                if !keep_container {
                    // Prefer H.264/AAC for QuickTime compatibility
                    args.push("-S".into());
                    args.push("vcodec:h264,acodec:m4a".into());
                }

                // Report the height actually delivered (stdout line
                // "PRISM:HEIGHT=N" once the file lands) so completion can
                // carry it. --print implies --quiet, which would silence the
                // progress lines the UI parses — --no-quiet restores them.
                args.push("--print".into());
                args.push("after_move:PRISM:HEIGHT=%(height)s".into());
                args.push("--no-quiet".into());
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

            if crate::force_ipv4(&app) {
                args.push("--force-ipv4".into());
            }

            // Fetch HLS/DASH fragments in parallel — the single biggest
            // throughput win on segmented streams (2–4× vs one connection).
            // Harmless for progressive downloads, where it's a no-op.
            args.push("-N".into());
            args.push("4".into());

            if let Some(browser) = crate::cookies_browser(&app) {
                args.push("--cookies-from-browser".into());
                args.push(browser);
            }

            if let Some(proxy) = crate::proxy_url(&app) {
                args.push("--proxy".into());
                args.push(proxy);
            }

            // Tell yt-dlp where ffmpeg is — Finder-launched apps may not have it in PATH
            let ffmpeg = find_ffmpeg(&app);
            if let Some(ref ffmpeg_path) = ffmpeg {
                args.push("--ffmpeg-location".into());
                // The folder, not the binary: yt-dlp looks for ffprobe beside
                // what it is given, and both live in the same place whether
                // they are the bundled pair or a package manager's.
                args.push(
                    std::path::Path::new(ffmpeg_path)
                        .parent()
                        .map(|dir| dir.to_string_lossy().into_owned())
                        .unwrap_or_else(|| ffmpeg_path.clone()),
                );
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

                // SponsorBlock: cut sponsor segments out, or mark everything
                // the community has flagged as chapters. Both are ffmpeg
                // postprocessors, hence inside the gate.
                match crate::sponsorblock_mode(&app).as_deref() {
                    Some("remove") => {
                        args.push("--sponsorblock-remove".into());
                        args.push("sponsor,selfpromo,interaction".into());
                    }
                    Some("mark") if !audio_only => {
                        args.push("--sponsorblock-mark".into());
                        args.push("all".into());
                    }
                    _ => {}
                }
            }

            // Options terminator + URL last (arg-injection defense; see lib::parse_url).
            args.push("--".into());
            args.push(url.clone());

            // Held for the life of this task, i.e. until the process is done.
            let Ok(_slot) = DOWNLOAD_SLOTS.clone().try_acquire_owned() else {
                log::warn!("download {id}: refused, {MAX_CONCURRENT_DOWNLOADS} already running");
                reserved.lock().await.remove(&id);
                emit_start_failure(
                    &app,
                    id,
                    PrismError::new(
                        ErrorCode::Busy,
                        format!("Too many downloads running at once (limit {})", MAX_CONCURRENT_DOWNLOADS),
                    ),
                );
                return;
            };

            let cmd = match crate::engine::ytdlp_command(&app) {
                Ok(c) => c.args(&args),
                Err(e) => {
                    reserved.lock().await.remove(&id);
                    emit_start_failure(
                        &app,
                        id,
                        PrismError::new(ErrorCode::EngineMissing, format!("Failed to find yt-dlp sidecar: {}", e)),
                    );
                    return;
                }
            };

            let (mut rx, child) = match cmd.spawn() {
                Ok(pair) => pair,
                Err(e) => {
                    reserved.lock().await.remove(&id);
                    emit_start_failure(
                        &app,
                        id,
                        PrismError::new(ErrorCode::EngineMissing, format!("Failed to start yt-dlp: {}", e)),
                    );
                    return;
                }
            };

            let alive = Arc::new(AtomicBool::new(true));
            {
                let mut map = downloads.lock().await;
                map.insert(id.clone(), ActiveDownload { child, alive: alive.clone() });
            }
            log::info!("download {id}: yt-dlp started");

            let mut success = false;
            // Prefer the last explicit "ERROR:" line for the failure message —
            // the last stderr line in general can be a progress fragment or
            // postprocessor chatter rather than the actual cause.
            let mut last_error = String::new();
            let mut last_stderr = String::new();
            // The failure's detail: redacted and capped again in PrismError.
            let mut stderr_tail = String::new();
            let mut timed_out = false;
            let mut actual_height: Option<u32> = None;
            let mut agg = PhaseAggregator::new();
            // yt-dlp prints a progress line per fragment/chunk — many per
            // second with -N. Each emit is an IPC hop plus a reducer pass and
            // a re-render, so cap the rate; the final 100% always goes out.
            let mut throttle = EmitThrottle::new(std::time::Duration::from_millis(250));

            loop {
                // Cancelled, or superseded by a newer run for this id: stop
                // reading rather than emit progress the item no longer owns.
                if !alive.load(Ordering::Relaxed) {
                    return;
                }
                // ffmpeg postprocessing (merging a multi-GB file) can be silent
                // for a long time — don't kill it as inactive.
                let inactivity = std::time::Duration::from_secs(if agg.processing { 1800 } else { 300 });
                match tokio::time::timeout(inactivity, rx.recv()).await {
                    Ok(Some(event)) => match event {
                        Event::Stdout(data) => {
                            let line = String::from_utf8_lossy(&data);
                            if let Some(h) = line.trim().strip_prefix("PRISM:HEIGHT=") {
                                actual_height = h.parse().ok(); // "NA" → None
                            }
                            if agg.on_line(&line) {
                                let _ = app.emit(&format!("download-progress-{}", id), agg.processing_event(&id));
                            }
                            if let Some(mut p) = parse_progress(&line, &PCT_RE, &SIZE_RE, &SPEED_RE, &ETA_RE, &id) {
                                agg.apply(&mut p);
                                if throttle.allow(p.progress) {
                                    let _ = app.emit(&format!("download-progress-{}", id), p);
                                }
                            }
                        }
                        Event::Stderr(data) => {
                            let line = String::from_utf8_lossy(&data);
                            let trimmed = line.trim();
                            if !trimmed.is_empty() {
                                last_stderr = clip_line(trimmed);
                                if trimmed.starts_with("ERROR") {
                                    last_error = last_stderr.clone();
                                }
                                stderr_tail.push_str(&last_stderr);
                                stderr_tail.push('\n');
                                if stderr_tail.len() > MAX_STDERR_TAIL {
                                    let mut cut = stderr_tail.len() - MAX_STDERR_TAIL;
                                    while !stderr_tail.is_char_boundary(cut) {
                                        cut += 1;
                                    }
                                    stderr_tail.drain(..cut);
                                }
                            }
                            if agg.on_line(&line) {
                                let _ = app.emit(&format!("download-progress-{}", id), agg.processing_event(&id));
                            }
                            if let Some(mut p) = parse_progress(&line, &PCT_RE, &SIZE_RE, &SPEED_RE, &ETA_RE, &id) {
                                agg.apply(&mut p);
                                if throttle.allow(p.progress) {
                                    let _ = app.emit(&format!("download-progress-{}", id), p);
                                }
                            }
                        }
                        Event::Terminated(code) => {
                            success = code == Some(0);
                            break;
                        }
                    },
                    Ok(None) => break,
                    Err(_) => {
                        // Inactivity timeout. Stays "alive" — this run still
                        // owns the id and reports its own failure, which is
                        // what drives the frontend's retry.
                        let stalled = downloads.lock().await.remove(&id);
                        if let Some(dl) = stalled {
                            dl.kill();
                        }
                        timed_out = true;
                        break;
                    }
                }
            }

            // Cancelled or superseded while we were reading: the map entry and
            // the template claim belong to whoever stopped us (or to the run
            // that replaced us), and the completion is not ours to report.
            if !alive.load(Ordering::SeqCst) {
                return;
            }

            // Remove from active downloads and release the template claim
            {
                let mut map = downloads.lock().await;
                map.remove(&id);
            }
            reserved.lock().await.remove(&id);

            if last_error.is_empty() {
                last_error = last_stderr;
            }
            if success {
                log::info!("download {id}: finished");
            } else {
                log::warn!("download {id}: failed: {last_error}");
            }

            let final_path = if success {
                // "Move completed to" runs before completion is reported, so
                // the Library records where the file actually ended up.
                find_output_file(&output_path)
                    .map(|path| crate::postprocess::move_file(&app, &path).unwrap_or(path))
            } else {
                None
            };
            // Flag the finished file as an internet download so the OS
            // applies its usual checks if it's opened outside Prism.
            if let Some(p) = &final_path {
                crate::quarantine::mark_downloaded(p);
            }

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
                    } else if timed_out {
                        Some(PrismError::new(ErrorCode::Timeout, "Download timed out (no activity for 5 minutes)"))
                    } else if last_error.is_empty() {
                        Some(PrismError::new(ErrorCode::Unknown, "Download failed or was cancelled"))
                    } else {
                        // Classify on the one line that failed; earlier
                        // warnings (e.g. about cookies) must not steer it.
                        Some(classify_output(&last_error).with_detail(&stderr_tail))
                    },
                    file_path: final_path,
                    file_size,
                    actual_height: if success { actual_height } else { None },
                    output_folder: None,
                },
            );
        });
    }

    pub async fn cancel_download(&self, id: &str) -> bool {
        let stopped = {
            let mut map = self.downloads.lock().await;
            match map.remove(id) {
                Some(dl) => {
                    dl.stop();
                    true
                }
                None => false,
            }
        };
        // Release the claim here rather than in the reader task: a stopped run
        // returns without touching shared state, and a leaked claim would push
        // the item's own retry onto a deduped path — a second copy of the file
        // instead of a resume.
        if stopped {
            self.reserved.lock().await.remove(id);
        }
        stopped
    }

    /// Kill every running download. Called on app exit: yt-dlp's forked worker
    /// outlives the app otherwise, and keeps downloading (and writing into the
    /// same files the next launch resumes) with nothing left to stop it.
    pub async fn kill_all(&self) {
        let running: Vec<ActiveDownload> = self.downloads.lock().await.drain().map(|(_, dl)| dl).collect();
        for dl in running {
            dl.stop();
        }
        self.reserved.lock().await.clear();
    }
}

/// Rate-limits progress emits: at most one per `min_gap`, except that a
/// 100% line is never dropped (it's the one the UI must see).
struct EmitThrottle {
    min_gap: std::time::Duration,
    last: Option<std::time::Instant>,
}

impl EmitThrottle {
    fn new(min_gap: std::time::Duration) -> Self {
        Self { min_gap, last: None }
    }

    fn allow(&mut self, progress: f64) -> bool {
        let now = std::time::Instant::now();
        let due = match self.last {
            None => true,
            Some(t) => now.duration_since(t) >= self.min_gap,
        };
        if due || progress >= 100.0 {
            self.last = Some(now);
            true
        } else {
            false
        }
    }
}

/// Folds yt-dlp's sequential per-file progress into one forward-only stream.
/// A merged download fetches the video file, then the audio file (and possibly
/// subtitles), each restarting at 0% with its own total — displayed raw, the
/// bar snaps back and the size/ETA swing wildly at every boundary. This banks
/// the bytes of each finished file and rewrites events cumulatively, and flags
/// the trailing ffmpeg postprocessing (merge/extract/embed) so the UI can show
/// a label instead of a frozen 100%.
struct PhaseAggregator {
    /// Bytes from files that already finished downloading.
    done_prev: u64,
    /// Progress of the file currently downloading.
    cur_done: u64,
    cur_total: u64,
    processing: bool,
}

const POSTPROCESS_MARKERS: [&str; 7] = [
    "[Merger]",
    "[ExtractAudio]",
    "[VideoRemuxer]",
    "[EmbedThumbnail]",
    "[Metadata]",
    "[SponsorBlock]",
    "[Fixup",
];

impl PhaseAggregator {
    fn new() -> Self {
        Self { done_prev: 0, cur_done: 0, cur_total: 0, processing: false }
    }

    /// Inspect a non-progress output line. Returns true when it flips the
    /// download into postprocessing — the caller emits a synthetic event so
    /// the UI switches immediately (ffmpeg may then be silent for minutes).
    fn on_line(&mut self, line: &str) -> bool {
        let l = line.trim();
        if l.starts_with("[download] Destination:") {
            // Next file starts: bank whatever the previous one downloaded.
            self.done_prev += self.cur_done;
            self.cur_done = 0;
            self.cur_total = 0;
            return false;
        }
        if !self.processing && POSTPROCESS_MARKERS.iter().any(|m| l.starts_with(m)) {
            self.processing = true;
            return true;
        }
        false
    }

    /// Rewrite a per-file progress event into cumulative terms.
    fn apply(&mut self, p: &mut DownloadProgress) {
        self.cur_done = p.downloaded_bytes;
        self.cur_total = p.total_bytes;
        p.downloaded_bytes = self.done_prev + self.cur_done;
        // A stream with an unknown size reports total 0 — leave its raw
        // percent alone rather than dividing by a bogus cumulative total.
        if p.total_bytes > 0 {
            p.total_bytes = self.done_prev + self.cur_total;
            p.progress = (p.downloaded_bytes as f64 / p.total_bytes as f64 * 100.0).min(100.0);
        }
    }

    /// Synthetic event marking the switch to ffmpeg postprocessing.
    fn processing_event(&self, id: &str) -> DownloadProgress {
        let done = self.done_prev + self.cur_done;
        DownloadProgress {
            id: id.to_string(),
            downloaded_bytes: done,
            total_bytes: done.max(self.done_prev + self.cur_total),
            progress: 100.0,
            speed: 0.0,
            eta: 0.0,
            stage: Some("processing"),
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
        stage: None,
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

    fn parsed(line: &str) -> DownloadProgress {
        parse_progress(line, &PCT_RE, &SIZE_RE, &SPEED_RE, &ETA_RE, "x").unwrap()
    }

    #[test]
    fn aggregator_makes_video_plus_audio_cumulative() {
        const MIB: u64 = 1024 * 1024;
        let mut agg = PhaseAggregator::new();

        assert!(!agg.on_line("[download] Destination: clip.f616.mp4"));
        let mut p = parsed(" 50.0% of 100.00MiB at 2.0MiB/s ETA 00:25");
        agg.apply(&mut p);
        assert_eq!(p.total_bytes, 100 * MIB);
        assert!((p.progress - 50.0).abs() < 0.1);

        let mut p = parsed("100.0% of 100.00MiB at 2.0MiB/s ETA 00:00");
        agg.apply(&mut p);

        // Audio file starts: bar must NOT reset — bytes and total accumulate.
        assert!(!agg.on_line("[download] Destination: clip.f140.m4a"));
        let mut p = parsed(" 10.0% of 10.00MiB at 1.0MiB/s ETA 00:09");
        agg.apply(&mut p);
        assert_eq!(p.downloaded_bytes, 101 * MIB);
        assert_eq!(p.total_bytes, 110 * MIB);
        assert!(p.progress > 90.0 && p.progress < 93.0);

        let mut p = parsed("100.0% of 10.00MiB at 1.0MiB/s ETA 00:00");
        agg.apply(&mut p);
        assert!((p.progress - 100.0).abs() < 0.01);

        // Merge begins: flips to processing exactly once, at 100%.
        assert!(agg.on_line("[Merger] Merging formats into \"clip.mp4\""));
        assert!(!agg.on_line("[Merger] Merging formats into \"clip.mp4\""));
        let e = agg.processing_event("x");
        assert_eq!(e.stage, Some("processing"));
        assert_eq!(e.progress, 100.0);
        assert_eq!(e.downloaded_bytes, 110 * MIB);
    }

    #[test]
    fn aggregator_leaves_unknown_totals_alone() {
        let mut agg = PhaseAggregator::new();
        agg.on_line("[download] Destination: live.mp4");
        // No "of <size>" → total 0; percent passes through untouched.
        let mut p = parsed(" 37.5% at 1.0MiB/s ETA 00:09");
        agg.apply(&mut p);
        assert_eq!(p.total_bytes, 0);
        assert!((p.progress - 37.5).abs() < 0.01);
    }

    #[test]
    fn throttle_caps_rate_but_never_drops_completion() {
        let mut t = EmitThrottle::new(std::time::Duration::from_secs(60));
        assert!(t.allow(1.0)); // first always passes
        assert!(!t.allow(2.0)); // too soon
        assert!(!t.allow(50.0));
        assert!(t.allow(100.0)); // completion passes regardless
        let mut t = EmitThrottle::new(std::time::Duration::ZERO);
        assert!(t.allow(1.0));
        assert!(t.allow(2.0)); // zero gap → everything passes
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
