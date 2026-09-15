//! Direct-link downloads: plain HTTP(S) files that yt-dlp has no business
//! handling — disk images, archives, installers, documents.
//!
//! When the server supports byte ranges the file is fetched over several
//! connections, each writing its own region of a preallocated `.prismpart`
//! file. A small state file beside it records each region's progress, so a
//! pause, a crash or a relaunch resumes instead of starting over — as long as
//! the server still vouches for the same file (ETag or Last-Modified). A
//! failed connection retries from where it stopped. An optional SHA-256 is
//! checked before the file is moved into place. Progress and completion use
//! the same events as the other engines, so the queue treats it like any
//! other transfer.

use std::collections::HashMap;
use std::io::SeekFrom;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use reqwest::header::{CONTENT_DISPOSITION, CONTENT_RANGE, CONTENT_TYPE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::download_manager::{DownloadComplete, DownloadProgress};
use crate::errors::{ErrorCode, PrismError};

/// Connections per file when the server allows ranges.
const DEFAULT_CONNECTIONS: usize = 4;
/// Below this per-connection share, extra connections cost more than they win.
const MIN_SEGMENT: u64 = 4 * 1024 * 1024;
/// Consecutive failures one connection survives before the download fails.
const SEGMENT_RETRIES: u32 = 5;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Silence on an open connection this long counts as a dropped connection.
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const STATE_FLUSH: Duration = Duration::from_secs(2);
const PROGRESS_TICK: Duration = Duration::from_millis(500);
/// Direct downloads running at once (the same backstop yt-dlp runs have).
const MAX_CONCURRENT: usize = 16;

const PART_SUFFIX: &str = ".prismpart";
const STATE_SUFFIX: &str = ".prismpart.json";

static SLOTS: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT)));

// ── Probing ─────────────────────────────────────────────────────────────

/// What a link turns out to be, from one tiny ranged request.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkProbe {
    pub final_url: String,
    pub filename: String,
    pub size: Option<u64>,
    pub accept_ranges: bool,
    pub content_type: Option<String>,
    /// Strong ETag or Last-Modified, sent as If-Range when resuming.
    #[serde(skip)]
    pub validator: Option<String>,
}

impl LinkProbe {
    /// An HTML page is a link to a site, not to a file.
    pub fn is_web_page(&self) -> bool {
        self.content_type.as_deref().is_some_and(|t| t.to_ascii_lowercase().starts_with("text/html"))
    }
}

pub(crate) async fn probe(client: &reqwest::Client, url: &str) -> Result<LinkProbe, PrismError> {
    let resp = client
        .get(url)
        .header(RANGE, "bytes=0-0")
        .send()
        .await
        .map_err(|e| network_error(&e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(status_error(status).0);
    }
    let headers = resp.headers();
    let text = |name| headers.get(name).and_then(|v: &reqwest::header::HeaderValue| v.to_str().ok());
    let final_url = resp.url().to_string();
    let accept_ranges = status == StatusCode::PARTIAL_CONTENT;
    let size = if accept_ranges {
        text(CONTENT_RANGE).and_then(content_range_total)
    } else {
        resp.content_length().filter(|n| *n > 0)
    };
    let validator = text(ETAG)
        .filter(|etag| !etag.starts_with("W/"))
        .or_else(|| text(LAST_MODIFIED))
        .map(str::to_string);
    let filename = text(CONTENT_DISPOSITION)
        .and_then(filename_from_disposition)
        .or_else(|| filename_from_url(&final_url))
        .map(|name| crate::torrent::safe_folder_name(&name))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "download".to_string());
    Ok(LinkProbe {
        final_url,
        filename,
        size,
        accept_ranges,
        content_type: text(CONTENT_TYPE).map(str::to_string),
        validator,
    })
}

/// `bytes 0-0/12345` → 12345 (`*` means unknown).
fn content_range_total(value: &str) -> Option<u64> {
    value.rsplit_once('/')?.1.trim().parse().ok()
}

/// RFC 6266: `filename*=UTF-8''…` (percent-encoded) wins over `filename="…"`.
fn filename_from_disposition(header: &str) -> Option<String> {
    let mut plain = None;
    for part in header.split(';').map(str::trim) {
        let Some((key, value)) = part.split_once('=') else { continue };
        let value = value.trim().trim_matches('"');
        match key.trim().to_ascii_lowercase().as_str() {
            "filename*" => {
                let encoded = value.splitn(3, '\'').nth(2).unwrap_or(value);
                if let Some(decoded) = percent_decode(encoded).filter(|d| !d.is_empty()) {
                    return Some(decoded);
                }
            }
            "filename" if !value.is_empty() => plain = Some(value.to_string()),
            _ => {}
        }
    }
    plain
}

fn filename_from_url(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let last = parsed.path_segments()?.rev().find(|s| !s.is_empty())?;
    percent_decode(last).filter(|name| !name.is_empty())
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

// ── Transfer ────────────────────────────────────────────────────────────

/// One file to fetch.
#[derive(Debug, Clone)]
pub(crate) struct Job {
    /// The link the user added — the identity a resume is matched on
    /// (the final URL may be a signed redirect that changes every time).
    pub source: String,
    /// Where requests go (after redirects).
    pub url: String,
    pub dest: PathBuf,
    pub size: Option<u64>,
    pub ranges: bool,
    pub validator: Option<String>,
    pub sha256: Option<String>,
    pub connections: usize,
}

/// Shared with the progress ticker and the cancel command.
#[derive(Clone)]
pub(crate) struct Transfer {
    pub downloaded: Arc<AtomicU64>,
    pub cancel: Arc<AtomicBool>,
    pub verifying: Arc<AtomicBool>,
    pub limiter: Arc<RateLimiter>,
    pub global: Arc<RateLimiter>,
}

impl Transfer {
    pub fn new(speed_limit: u64, global: Arc<RateLimiter>) -> Self {
        Transfer {
            downloaded: Arc::new(AtomicU64::new(0)),
            cancel: Arc::new(AtomicBool::new(false)),
            verifying: Arc::new(AtomicBool::new(false)),
            limiter: Arc::new(RateLimiter::new(speed_limit)),
            global,
        }
    }
}

#[derive(Debug)]
pub(crate) enum Halt {
    /// Stopped by the user; the partial file and its state stay for a resume.
    Cancelled,
    Failed(PrismError),
}

/// Download `job`, verify it, and move it into place. Returns the final path
/// (which differs from `job.dest` if a file of that name appeared meanwhile).
pub(crate) async fn transfer(client: &reqwest::Client, job: &Job, t: &Transfer) -> Result<PathBuf, Halt> {
    let part = with_suffix(&job.dest, PART_SUFFIX);
    let state_path = with_suffix(&job.dest, STATE_SUFFIX);

    let mut fresh = false;
    loop {
        let result = match job.size {
            Some(size) if job.ranges && size > 0 => ranged(client, job, t, &part, &state_path, size, fresh).await,
            _ => single_stream(client, job, t, &part).await,
        };
        match result {
            Ok(()) => break,
            // The server now serves a different file: start over, once.
            Err(Stop::Restart) if !fresh => {
                log::warn!("direct download: the file changed on the server; starting over");
                fresh = true;
            }
            Err(Stop::Restart) => {
                return Err(Halt::Failed(PrismError::new(
                    ErrorCode::Network,
                    "The file kept changing on the server while it downloaded",
                )))
            }
            Err(Stop::Cancelled) => return Err(Halt::Cancelled),
            Err(Stop::Failed(e)) => return Err(Halt::Failed(e)),
        }
    }

    if let Some(expected) = &job.sha256 {
        t.verifying.store(true, Ordering::Relaxed);
        let path = part.clone();
        let actual = tauri::async_runtime::spawn_blocking(move || crate::engine::sha256_file(&path))
            .await
            .map_err(|e| Halt::Failed(PrismError::new(ErrorCode::Unknown, format!("Checksum check failed: {e}"))))?
            .map_err(|e| Halt::Failed(io_error(e)))?;
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(&part).await;
            let _ = tokio::fs::remove_file(&state_path).await;
            return Err(Halt::Failed(
                PrismError::new(ErrorCode::Checksum, "The downloaded file doesn't match the expected SHA-256")
                    .with_detail(format!("expected {expected}\nactual   {actual}")),
            ));
        }
    }

    let dest = free_destination(&job.dest);
    tokio::fs::rename(&part, &dest).await.map_err(|e| Halt::Failed(io_error(e)))?;
    let _ = tokio::fs::remove_file(&state_path).await;
    Ok(dest)
}

enum Stop {
    Cancelled,
    Restart,
    Failed(PrismError),
}

/// One contiguous byte range of the file and how much of it is written.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
struct Segment {
    start: u64,
    /// Inclusive.
    end: u64,
    done: u64,
}

impl Segment {
    fn len(&self) -> u64 {
        self.end - self.start + 1
    }
    fn finished(&self) -> bool {
        self.done >= self.len()
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartState {
    source: String,
    size: u64,
    validator: Option<String>,
    segments: Vec<Segment>,
}

fn plan_segments(size: u64, connections: usize) -> Vec<Segment> {
    let count = (size / MIN_SEGMENT).clamp(1, connections.max(1) as u64);
    let share = size / count;
    (0..count)
        .map(|i| {
            let start = i * share;
            let end = if i + 1 == count { size - 1 } else { start + share - 1 };
            Segment { start, end, done: 0 }
        })
        .collect()
}

/// Segments to resume from, if the saved state matches this exact file.
/// Without a validator there's no way to know the server's file is the same
/// one, so there's no resume.
async fn saved_segments(state_path: &Path, part: &Path, job: &Job, size: u64) -> Option<Vec<Segment>> {
    job.validator.as_ref()?;
    let state: PartState = serde_json::from_str(&tokio::fs::read_to_string(state_path).await.ok()?).ok()?;
    let part_len = tokio::fs::metadata(part).await.ok()?.len();
    let mut expected_start = 0;
    for seg in &state.segments {
        if seg.start != expected_start || seg.end < seg.start || seg.done > seg.len() {
            return None;
        }
        expected_start = seg.end + 1;
    }
    (state.source == job.source
        && state.size == size
        && state.validator == job.validator
        && part_len == size
        && expected_start == size)
        .then_some(state.segments)
}

async fn save_state(state_path: &Path, job: &Job, size: u64, segments: &[Segment]) {
    let state = PartState {
        source: job.source.clone(),
        size,
        validator: job.validator.clone(),
        segments: segments.to_vec(),
    };
    let Ok(text) = serde_json::to_string(&state) else { return };
    let tmp = with_suffix(state_path, ".tmp");
    if tokio::fs::write(&tmp, text).await.is_ok() {
        let _ = tokio::fs::rename(&tmp, state_path).await;
    }
}

async fn ranged(
    client: &reqwest::Client,
    job: &Job,
    t: &Transfer,
    part: &Path,
    state_path: &Path,
    size: u64,
    fresh: bool,
) -> Result<(), Stop> {
    let resumed = if fresh { None } else { saved_segments(state_path, part, job, size).await };
    let plan = match resumed {
        Some(segments) => {
            log::info!("direct download: resuming {} of {size} bytes", segments.iter().map(|s| s.done).sum::<u64>());
            segments
        }
        None => {
            let file = tokio::fs::File::create(part).await.map_err(|e| Stop::Failed(io_error(e)))?;
            // Reserve the whole file up front: out-of-space shows up now, not at 90%.
            file.set_len(size).await.map_err(|e| Stop::Failed(io_error(e)))?;
            let plan = plan_segments(size, job.connections);
            save_state(state_path, job, size, &plan).await;
            plan
        }
    };
    t.downloaded.store(plan.iter().map(|s| s.done).sum(), Ordering::Relaxed);

    let count = plan.len();
    let segments = Arc::new(std::sync::Mutex::new(plan));
    let halt = Arc::new(AtomicBool::new(false));
    let workers: Vec<_> = (0..count)
        .map(|index| {
            let (client, job, part, segments, t, halt) =
                (client.clone(), job.clone(), part.to_path_buf(), segments.clone(), t.clone(), halt.clone());
            tauri::async_runtime::spawn(async move { fetch_segment(&client, &job, &part, index, &segments, &t, &halt).await })
        })
        .collect();

    // Persist progress while the workers run, so a crash loses seconds, not the file.
    let flushing = Arc::new(AtomicBool::new(true));
    let flusher = {
        let (flushing, segments, job, state_path) =
            (flushing.clone(), segments.clone(), job.clone(), state_path.to_path_buf());
        tauri::async_runtime::spawn(async move {
            while flushing.load(Ordering::Relaxed) {
                tokio::time::sleep(STATE_FLUSH).await;
                let snapshot = segments.lock().map(|s| s.clone()).unwrap_or_default();
                save_state(&state_path, &job, size, &snapshot).await;
            }
        })
    };

    let mut outcome: Result<(), Stop> = Ok(());
    for worker in workers {
        let result = worker.await.unwrap_or_else(|e| {
            Err(Stop::Failed(PrismError::new(ErrorCode::Unknown, format!("Download worker stopped: {e}"))))
        });
        // Report the most meaningful stop: cancel over restart over failure.
        outcome = match (outcome, result) {
            (Err(Stop::Cancelled), _) | (_, Err(Stop::Cancelled)) => Err(Stop::Cancelled),
            (Err(Stop::Restart), _) | (_, Err(Stop::Restart)) => Err(Stop::Restart),
            (Err(e), _) | (_, Err(e)) => Err(e),
            (Ok(()), Ok(())) => Ok(()),
        };
    }
    flushing.store(false, Ordering::Relaxed);
    let _ = flusher.await;
    let snapshot = segments.lock().map(|s| s.clone()).unwrap_or_default();
    save_state(state_path, job, size, &snapshot).await;
    if outcome.is_ok() && !snapshot.iter().all(Segment::finished) {
        return Err(Stop::Failed(PrismError::new(ErrorCode::Network, "The download ended before the whole file arrived")));
    }
    outcome
}

enum Attempt {
    Retry(PrismError),
    Fatal(PrismError),
    Restart,
    Cancelled,
}

async fn fetch_segment(
    client: &reqwest::Client,
    job: &Job,
    part: &Path,
    index: usize,
    segments: &std::sync::Mutex<Vec<Segment>>,
    t: &Transfer,
    halt: &AtomicBool,
) -> Result<(), Stop> {
    let mut failures = 0u32;
    loop {
        if t.cancel.load(Ordering::Relaxed) {
            return Err(Stop::Cancelled);
        }
        // A sibling connection failed; its error is the one reported.
        if halt.load(Ordering::Relaxed) {
            return Ok(());
        }
        let Some(seg) = segments.lock().ok().map(|s| s[index]) else {
            return Err(Stop::Failed(PrismError::new(ErrorCode::Unknown, "Download state was lost")));
        };
        if seg.finished() {
            return Ok(());
        }
        match fetch_range(client, job, part, index, seg, segments, t).await {
            Ok(()) => failures = 0,
            Err(Attempt::Cancelled) => return Err(Stop::Cancelled),
            Err(Attempt::Restart) => {
                halt.store(true, Ordering::Relaxed);
                return Err(Stop::Restart);
            }
            Err(Attempt::Fatal(e)) => {
                halt.store(true, Ordering::Relaxed);
                return Err(Stop::Failed(e));
            }
            Err(Attempt::Retry(e)) => {
                failures += 1;
                if failures > SEGMENT_RETRIES {
                    halt.store(true, Ordering::Relaxed);
                    return Err(Stop::Failed(e));
                }
                backoff(failures, &t.cancel).await;
            }
        }
    }
}

async fn fetch_range(
    client: &reqwest::Client,
    job: &Job,
    part: &Path,
    index: usize,
    seg: Segment,
    segments: &std::sync::Mutex<Vec<Segment>>,
    t: &Transfer,
) -> Result<(), Attempt> {
    let from = seg.start + seg.done;
    let mut request = client.get(&job.url).header(RANGE, format!("bytes={from}-{}", seg.end));
    if let Some(validator) = &job.validator {
        request = request.header(IF_RANGE, validator);
    }
    let mut resp = request.send().await.map_err(|e| Attempt::Retry(network_error(&e)))?;
    match resp.status() {
        StatusCode::PARTIAL_CONTENT => {}
        // A full body instead of the range: If-Range failed, the file changed.
        StatusCode::OK => return Err(Attempt::Restart),
        status => {
            let (error, retry) = status_error(status);
            return Err(if retry { Attempt::Retry(error) } else { Attempt::Fatal(error) });
        }
    }

    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(part)
        .await
        .map_err(|e| Attempt::Fatal(io_error(e)))?;
    file.seek(SeekFrom::Start(from)).await.map_err(|e| Attempt::Fatal(io_error(e)))?;

    let mut position = from;
    while position <= seg.end {
        if t.cancel.load(Ordering::Relaxed) {
            let _ = file.flush().await;
            return Err(Attempt::Cancelled);
        }
        let Some(chunk) = resp.chunk().await.map_err(|e| Attempt::Retry(network_error(&e)))? else {
            let _ = file.flush().await;
            return Err(Attempt::Retry(PrismError::new(ErrorCode::Network, "The connection closed early")));
        };
        let room = (seg.end + 1 - position) as usize;
        let chunk = if chunk.len() > room { chunk.slice(..room) } else { chunk };
        let n = chunk.len() as u64;
        t.limiter.acquire(n).await;
        t.global.acquire(n).await;
        file.write_all(&chunk).await.map_err(|e| Attempt::Fatal(io_error(e)))?;
        position += n;
        if let Ok(mut s) = segments.lock() {
            s[index].done += n;
        }
        t.downloaded.fetch_add(n, Ordering::Relaxed);
    }
    file.flush().await.map_err(|e| Attempt::Fatal(io_error(e)))?;
    Ok(())
}

/// No ranges (or no size): one connection from the start; a failure restarts it.
async fn single_stream(client: &reqwest::Client, job: &Job, t: &Transfer, part: &Path) -> Result<(), Stop> {
    let mut failures = 0u32;
    loop {
        match stream_whole(client, job, t, part).await {
            Ok(()) => return Ok(()),
            Err(Attempt::Cancelled) => return Err(Stop::Cancelled),
            Err(Attempt::Restart) => return Err(Stop::Restart),
            Err(Attempt::Fatal(e)) => return Err(Stop::Failed(e)),
            Err(Attempt::Retry(e)) => {
                failures += 1;
                if failures > SEGMENT_RETRIES {
                    return Err(Stop::Failed(e));
                }
                backoff(failures, &t.cancel).await;
            }
        }
    }
}

async fn stream_whole(client: &reqwest::Client, job: &Job, t: &Transfer, part: &Path) -> Result<(), Attempt> {
    t.downloaded.store(0, Ordering::Relaxed);
    let mut resp = client.get(&job.url).send().await.map_err(|e| Attempt::Retry(network_error(&e)))?;
    if !resp.status().is_success() {
        let (error, retry) = status_error(resp.status());
        return Err(if retry { Attempt::Retry(error) } else { Attempt::Fatal(error) });
    }
    let mut file = tokio::fs::File::create(part).await.map_err(|e| Attempt::Fatal(io_error(e)))?;
    let mut written = 0u64;
    while let Some(chunk) = resp.chunk().await.map_err(|e| Attempt::Retry(network_error(&e)))? {
        if t.cancel.load(Ordering::Relaxed) {
            return Err(Attempt::Cancelled);
        }
        let n = chunk.len() as u64;
        t.limiter.acquire(n).await;
        t.global.acquire(n).await;
        file.write_all(&chunk).await.map_err(|e| Attempt::Fatal(io_error(e)))?;
        written += n;
        t.downloaded.fetch_add(n, Ordering::Relaxed);
    }
    file.flush().await.map_err(|e| Attempt::Fatal(io_error(e)))?;
    match job.size {
        Some(size) if written != size => {
            Err(Attempt::Retry(PrismError::new(ErrorCode::Network, "The connection closed before the whole file arrived")))
        }
        _ => Ok(()),
    }
}

/// 0.5 s, 1 s, 2 s … capped at 10 s; returns early on cancel.
async fn backoff(failures: u32, cancel: &AtomicBool) {
    let total = Duration::from_millis(250u64.saturating_mul(1 << failures.min(10))).min(Duration::from_secs(10));
    let started = Instant::now();
    while started.elapsed() < total && !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Bytes-per-second token bucket; 0 = unlimited. Bursts up to one second.
pub struct RateLimiter {
    bps: AtomicU64,
    bucket: tokio::sync::Mutex<(Instant, f64)>,
}

impl RateLimiter {
    pub fn new(bps: u64) -> Self {
        RateLimiter { bps: AtomicU64::new(bps), bucket: tokio::sync::Mutex::new((Instant::now(), 0.0)) }
    }

    pub fn set(&self, bps: u64) {
        self.bps.store(bps, Ordering::Relaxed);
    }

    async fn acquire(&self, bytes: u64) {
        let bps = self.bps.load(Ordering::Relaxed);
        if bps == 0 {
            return;
        }
        let wait = {
            let mut bucket = self.bucket.lock().await;
            let now = Instant::now();
            let rate = bps as f64;
            let refilled = bucket.1 + now.duration_since(bucket.0).as_secs_f64() * rate;
            bucket.0 = now;
            bucket.1 = refilled.min(rate) - bytes as f64;
            if bucket.1 < 0.0 {
                Duration::from_secs_f64(-bucket.1 / rate)
            } else {
                Duration::ZERO
            }
        };
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// `name.ext`, or `name (1).ext`, `name (2).ext`… — never an existing file.
fn free_destination(wanted: &Path) -> PathBuf {
    if !wanted.exists() {
        return wanted.to_path_buf();
    }
    let parent = wanted.parent().unwrap_or(Path::new(""));
    let stem = wanted.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = wanted.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (1..10_000)
        .map(|n| parent.join(format!("{stem} ({n}){ext}")))
        .find(|candidate| !candidate.exists())
        .unwrap_or_else(|| wanted.to_path_buf())
}

fn network_error(e: &reqwest::Error) -> PrismError {
    let code = if e.is_timeout() { ErrorCode::Timeout } else { ErrorCode::Network };
    PrismError::new(code, format!("Connection problem: {e}"))
}

/// The error for an HTTP status, and whether retrying the request can help.
fn status_error(status: StatusCode) -> (PrismError, bool) {
    let (code, retry) = match status.as_u16() {
        401 | 403 => (ErrorCode::Forbidden, false),
        404 | 410 => (ErrorCode::Unavailable, false),
        416 => (ErrorCode::Network, true),
        429 => (ErrorCode::RateLimited, true),
        500..=599 => (ErrorCode::Network, true),
        _ => (ErrorCode::Unknown, false),
    };
    (PrismError::new(code, format!("The server answered HTTP {status}")), retry)
}

fn io_error(e: std::io::Error) -> PrismError {
    let code = match e.raw_os_error() {
        // ENOSPC (unix) / ERROR_DISK_FULL (Windows)
        #[cfg(unix)]
        Some(28) => ErrorCode::DiskFull,
        #[cfg(windows)]
        Some(112) => ErrorCode::DiskFull,
        _ if e.kind() == std::io::ErrorKind::PermissionDenied => ErrorCode::Permission,
        _ => ErrorCode::Unknown,
    };
    PrismError::new(code, format!("Could not write the file: {e}"))
}

fn checked_url(url: &str) -> Result<url::Url, PrismError> {
    url::Url::parse(url.trim())
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .ok_or_else(|| PrismError::new(ErrorCode::InvalidInput, "Direct downloads need an http(s) link"))
}

fn client_for(app: &AppHandle) -> Result<reqwest::Client, PrismError> {
    let mut builder = reqwest::Client::builder()
        .user_agent(concat!("Prism/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(10));
    if crate::force_ipv4(app) {
        builder = builder.local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    }
    if let Some(proxy) = crate::proxy_url(app) {
        if !(proxy.starts_with("http://") || proxy.starts_with("https://")) {
            return Err(PrismError::new(
                ErrorCode::InvalidInput,
                "Direct downloads can use HTTP(S) proxies only — the SOCKS proxy applies to video downloads",
            ));
        }
        let proxy = reqwest::Proxy::all(&proxy)
            .map_err(|e| PrismError::new(ErrorCode::InvalidInput, format!("Invalid proxy: {e}")))?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|e| PrismError::new(ErrorCode::Unknown, format!("Failed to create HTTP client: {e}")))
}

// ── Commands ────────────────────────────────────────────────────────────

pub struct HttpEngine {
    active: tokio::sync::Mutex<HashMap<String, Arc<AtomicBool>>>,
    global: Arc<RateLimiter>,
}

impl HttpEngine {
    pub fn new() -> Self {
        HttpEngine { active: tokio::sync::Mutex::new(HashMap::new()), global: Arc::new(RateLimiter::new(0)) }
    }
}

/// What a link is: a file (name, size, resumable) or a web page.
#[tauri::command]
pub async fn probe_direct_link(app: AppHandle, url: String) -> Result<LinkProbe, PrismError> {
    let url = checked_url(&url)?;
    probe(&client_for(&app)?, url.as_str()).await
}

#[tauri::command]
pub async fn start_http_download(
    app: AppHandle,
    id: String,
    url: String,
    output_dir: String,
    filename: Option<String>,
    sha256: Option<String>,
    speed_limit: Option<u64>,
) -> Result<(), PrismError> {
    let source = checked_url(&url)?;
    let sha256 = sha256.map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty());
    if sha256.as_deref().is_some_and(|s| s.len() != 64 || !s.chars().all(|c| c.is_ascii_hexdigit())) {
        return Err(PrismError::new(ErrorCode::InvalidInput, "A SHA-256 checksum is 64 hexadecimal characters"));
    }
    let dir = crate::validate_download_path(&output_dir, &crate::picked_dirs(&app))
        .map_err(|e| PrismError::new(ErrorCode::Permission, e))?;
    let dir = PathBuf::from(dir);
    tokio::fs::create_dir_all(&dir).await.map_err(io_error)?;

    let client = client_for(&app)?;
    let link = probe(&client, source.as_str()).await?;
    if link.is_web_page() {
        return Err(PrismError::new(ErrorCode::Unsupported, "That link opens a web page, not a file"));
    }
    let name = filename
        .map(|f| crate::torrent::safe_folder_name(&f))
        .filter(|f| !f.is_empty())
        .unwrap_or_else(|| link.filename.clone());
    let wanted = dir.join(&name);
    // An unfinished download of this name resumes; anything else never
    // overwrites an existing file.
    let dest = if with_suffix(&wanted, STATE_SUFFIX).exists() { wanted } else { free_destination(&wanted) };
    if let (Some(size), Ok(available)) = (link.size, fs2::available_space(&dir)) {
        if available < size {
            return Err(PrismError::new(
                ErrorCode::DiskFull,
                format!("Not enough disk space: need {} MB free, have {} MB", size / 1_048_576, available / 1_048_576),
            ));
        }
    }

    let slot = SLOTS.clone().try_acquire_owned().map_err(|_| {
        PrismError::new(ErrorCode::Busy, format!("Too many direct downloads running at once (limit {MAX_CONCURRENT})"))
    })?;
    let engine = app.state::<HttpEngine>();
    let transfer_state = Transfer::new(speed_limit.unwrap_or(0), engine.global.clone());
    if let Some(previous) = engine.active.lock().await.insert(id.clone(), transfer_state.cancel.clone()) {
        previous.store(true, Ordering::Relaxed);
    }
    let job = Job {
        source: source.to_string(),
        url: link.final_url.clone(),
        dest,
        size: link.size,
        ranges: link.accept_ranges,
        validator: link.validator.clone(),
        sha256,
        connections: DEFAULT_CONNECTIONS,
    };
    log::info!(
        "direct download {id}: started ({})",
        if job.ranges && job.size.is_some() { "ranged" } else { "single stream" }
    );

    tauri::async_runtime::spawn(async move {
        let _slot = slot;
        let finished = Arc::new(AtomicBool::new(false));
        let ticker = tauri::async_runtime::spawn(progress_ticker(
            app.clone(),
            id.clone(),
            job.size,
            transfer_state.clone(),
            finished.clone(),
        ));
        let result = transfer(&client, &job, &transfer_state).await;
        finished.store(true, Ordering::Relaxed);
        let _ = ticker.await;

        // Superseded or cancelled: whoever stopped this run owns the id now.
        let engine = app.state::<HttpEngine>();
        {
            let mut active = engine.active.lock().await;
            match active.get(&id) {
                Some(current) if Arc::ptr_eq(current, &transfer_state.cancel) => {
                    active.remove(&id);
                }
                _ => return,
            }
        }
        let complete = match result {
            Err(Halt::Cancelled) => return,
            Ok(path) => {
                let path = path.to_string_lossy().into_owned();
                crate::quarantine::mark_downloaded(&path);
                let file_size = std::fs::metadata(&path).ok().map(|m| m.len());
                log::info!("direct download {id}: finished");
                DownloadComplete {
                    id: id.clone(),
                    success: true,
                    error: None,
                    file_path: Some(path),
                    file_size,
                    actual_height: None,
                    output_folder: None,
                }
            }
            Err(Halt::Failed(error)) => {
                log::warn!("direct download {id}: failed: {}", error.summary);
                DownloadComplete {
                    id: id.clone(),
                    success: false,
                    error: Some(error),
                    file_path: None,
                    file_size: None,
                    actual_height: None,
                    output_folder: None,
                }
            }
        };
        let _ = app.emit(&format!("download-complete-{id}"), complete);
    });
    Ok(())
}

async fn progress_ticker(app: AppHandle, id: String, size: Option<u64>, t: Transfer, finished: Arc<AtomicBool>) {
    let mut last_bytes = t.downloaded.load(Ordering::Relaxed);
    let mut last_at = Instant::now();
    let mut speed = 0.0f64;
    while !finished.load(Ordering::Relaxed) {
        tokio::time::sleep(PROGRESS_TICK).await;
        let bytes = t.downloaded.load(Ordering::Relaxed);
        let elapsed = last_at.elapsed().as_secs_f64().max(0.001);
        let instant = bytes.saturating_sub(last_bytes) as f64 / elapsed;
        speed = if speed == 0.0 { instant } else { speed * 0.7 + instant * 0.3 };
        (last_bytes, last_at) = (bytes, Instant::now());
        let total = size.unwrap_or(0);
        let _ = app.emit(
            &format!("download-progress-{id}"),
            DownloadProgress {
                id: id.clone(),
                downloaded_bytes: bytes,
                total_bytes: total,
                progress: if total > 0 { (bytes as f64 / total as f64 * 100.0).min(100.0) } else { 0.0 },
                speed,
                eta: if speed > 0.0 && total > bytes { (total - bytes) as f64 / speed } else { 0.0 },
                stage: t.verifying.load(Ordering::Relaxed).then_some("processing"),
            },
        );
    }
}

/// Stop a direct download, keeping the partial file so it can resume.
#[tauri::command]
pub async fn cancel_http_download(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(cancel) = app.state::<HttpEngine>().active.lock().await.remove(&id) {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Session-wide limit for direct downloads (quiet hours), on top of per-item limits.
#[tauri::command]
pub async fn set_http_rate_limit(app: AppHandle, bytes_per_second: u64) -> Result<(), String> {
    app.state::<HttpEngine>().global.set(bytes_per_second);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[test]
    fn plans_segments_that_cover_the_file_exactly() {
        let size = 10 * 1024 * 1024 + 7;
        let plan = plan_segments(size, 4);
        assert_eq!(plan.len(), 2, "10 MiB at 4 MiB minimum share → 2 connections");
        assert_eq!(plan[0].start, 0);
        assert_eq!(plan.last().unwrap().end, size - 1);
        for pair in plan.windows(2) {
            assert_eq!(pair[0].end + 1, pair[1].start);
        }
        assert_eq!(plan_segments(100, 4), vec![Segment { start: 0, end: 99, done: 0 }]);
        assert_eq!(plan_segments(64 * 1024 * 1024, 4).len(), 4);
    }

    #[test]
    fn reads_filenames_from_headers_and_urls() {
        assert_eq!(filename_from_disposition(r#"attachment; filename="report.pdf""#).as_deref(), Some("report.pdf"));
        assert_eq!(
            filename_from_disposition(r#"attachment; filename="fallback.txt"; filename*=UTF-8''na%C3%AFve%20file.txt"#).as_deref(),
            Some("naïve file.txt")
        );
        assert_eq!(filename_from_disposition("inline"), None);
        assert_eq!(filename_from_url("https://x.org/pub/debian-13.5.0-amd64-netinst.iso?sig=1").as_deref(), Some("debian-13.5.0-amd64-netinst.iso"));
        assert_eq!(filename_from_url("https://x.org/a%20b.zip").as_deref(), Some("a b.zip"));
        assert_eq!(filename_from_url("https://x.org/"), None);
        assert_eq!(content_range_total("bytes 0-0/12345"), Some(12345));
        assert_eq!(content_range_total("bytes 0-0/*"), None);
    }

    // ── A tiny HTTP server with optional Range support ──────────────────

    struct Server {
        body: Vec<u8>,
        ranges: bool,
        etag: std::sync::Mutex<String>,
        /// Cut the first response after this many body bytes.
        drop_first_after: Option<usize>,
        dropped: AtomicBool,
        bytes_sent: AtomicU64,
    }

    impl Server {
        fn new(size: usize, ranges: bool) -> Arc<Self> {
            let body = (0..size).map(|i| (i * 31 % 251) as u8).collect();
            Arc::new(Server {
                body,
                ranges,
                etag: std::sync::Mutex::new("\"v1\"".into()),
                drop_first_after: None,
                dropped: AtomicBool::new(false),
                bytes_sent: AtomicU64::new(0),
            })
        }
    }

    async fn serve(server: Arc<Server>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tauri::async_runtime::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                tauri::async_runtime::spawn(handle(socket, server.clone()));
            }
        });
        format!("http://{addr}/files/test.bin")
    }

    async fn handle(mut socket: tokio::net::TcpStream, server: Arc<Server>) {
        loop {
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                match socket.read(&mut byte).await {
                    Ok(1) => request.push(byte[0]),
                    _ => return,
                }
            }
            let text = String::from_utf8_lossy(&request).to_ascii_lowercase();
            let header = |name: &str| {
                text.lines().find_map(|l| l.strip_prefix(&format!("{name}:")).map(|v| v.trim().to_string()))
            };
            let len = server.body.len();
            let etag = server.etag.lock().unwrap().clone();
            let if_range_ok = header("if-range").map_or(true, |v| v == etag.to_ascii_lowercase());
            let range = header("range").filter(|_| server.ranges && if_range_ok).and_then(|r| {
                let (a, b) = r.strip_prefix("bytes=")?.split_once('-')?;
                let start: usize = a.parse().ok()?;
                let end: usize = if b.is_empty() { len - 1 } else { b.parse::<usize>().ok()?.min(len - 1) };
                Some((start, end))
            });
            let (status, start, end) = match range {
                Some((s, e)) => ("206 Partial Content", s, e),
                None => ("200 OK", 0, len - 1),
            };
            let mut head = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nETag: {etag}\r\n",
                end - start + 1
            );
            if server.ranges {
                head.push_str("Accept-Ranges: bytes\r\n");
            }
            if range.is_some() {
                head.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
            }
            head.push_str("\r\n");
            if socket.write_all(head.as_bytes()).await.is_err() {
                return;
            }
            let mut slice = &server.body[start..=end];
            if let Some(cut) = server.drop_first_after {
                if slice.len() > cut && !server.dropped.swap(true, Ordering::SeqCst) {
                    slice = &slice[..cut];
                    let _ = socket.write_all(slice).await;
                    server.bytes_sent.fetch_add(slice.len() as u64, Ordering::Relaxed);
                    return; // connection drops mid-body
                }
            }
            for piece in slice.chunks(64 * 1024) {
                if socket.write_all(piece).await.is_err() {
                    return;
                }
                server.bytes_sent.fetch_add(piece.len() as u64, Ordering::Relaxed);
            }
        }
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("prism-http-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn test_client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().read_timeout(Duration::from_secs(5)).build().unwrap()
    }

    async fn job_for(client: &reqwest::Client, url: &str, dir: &Path, sha256: Option<String>) -> Job {
        let link = probe(client, url).await.unwrap();
        Job {
            source: url.to_string(),
            url: link.final_url,
            dest: dir.join(&link.filename),
            size: link.size,
            ranges: link.accept_ranges,
            validator: link.validator,
            sha256,
            connections: DEFAULT_CONNECTIONS,
        }
    }

    const TEN_MIB: usize = 10 * 1024 * 1024 + 123;

    #[test]
    fn ranged_download_arrives_intact_over_several_connections() {
        tauri::async_runtime::block_on(async {
            let server = Server::new(TEN_MIB, true);
            let url = serve(server.clone()).await;
            let tmp = TempDir::new("ranged");
            let client = test_client();
            let job = job_for(&client, &url, &tmp.0, None).await;
            assert!(job.ranges);
            assert_eq!(job.size, Some(TEN_MIB as u64));

            let path = transfer(&client, &job, &Transfer::new(0, Arc::new(RateLimiter::new(0)))).await.unwrap();
            assert_eq!(path, tmp.0.join("test.bin"));
            assert!(std::fs::read(&path).unwrap() == server.body);
            assert!(!with_suffix(&path, PART_SUFFIX).exists());
            assert!(!with_suffix(&path, STATE_SUFFIX).exists());
        });
    }

    #[test]
    fn server_without_ranges_uses_one_stream() {
        tauri::async_runtime::block_on(async {
            let server = Server::new(300_000, false);
            let url = serve(server.clone()).await;
            let tmp = TempDir::new("single");
            let client = test_client();
            let job = job_for(&client, &url, &tmp.0, None).await;
            assert!(!job.ranges);
            let path = transfer(&client, &job, &Transfer::new(0, Arc::new(RateLimiter::new(0)))).await.unwrap();
            assert!(std::fs::read(path).unwrap() == server.body);
        });
    }

    #[test]
    fn a_dropped_connection_resumes_where_it_stopped() {
        tauri::async_runtime::block_on(async {
            let mut server = Server::new(TEN_MIB, true);
            Arc::get_mut(&mut server).unwrap().drop_first_after = Some(1024 * 1024);
            let url = serve(server.clone()).await;
            let tmp = TempDir::new("drop");
            let client = test_client();
            // The probe's 1-byte response is too short to be cut; the first cut
            // lands on a real segment.
            let job = job_for(&client, &url, &tmp.0, None).await;
            let path = transfer(&client, &job, &Transfer::new(0, Arc::new(RateLimiter::new(0)))).await.unwrap();
            assert!(server.dropped.load(Ordering::SeqCst), "the test server should have cut a connection");
            assert!(std::fs::read(path).unwrap() == server.body);
        });
    }

    #[test]
    fn checksum_mismatch_fails_and_leaves_no_file() {
        tauri::async_runtime::block_on(async {
            let server = Server::new(200_000, true);
            let url = serve(server).await;
            let tmp = TempDir::new("sha");
            let client = test_client();
            let job = job_for(&client, &url, &tmp.0, Some("0".repeat(64))).await;
            match transfer(&client, &job, &Transfer::new(0, Arc::new(RateLimiter::new(0)))).await {
                Err(Halt::Failed(e)) => assert_eq!(e.code, ErrorCode::Checksum),
                other => panic!("expected a checksum failure, got {other:?}"),
            }
            assert!(!job.dest.exists());
            assert!(!with_suffix(&job.dest, PART_SUFFIX).exists());
        });
    }

    #[test]
    fn matching_checksum_passes() {
        tauri::async_runtime::block_on(async {
            let server = Server::new(200_000, true);
            let expected = {
                use sha2::{Digest, Sha256};
                Sha256::digest(&server.body).iter().map(|b| format!("{b:02x}")).collect::<String>()
            };
            let url = serve(server).await;
            let tmp = TempDir::new("sha-ok");
            let client = test_client();
            let job = job_for(&client, &url, &tmp.0, Some(expected)).await;
            assert!(transfer(&client, &job, &Transfer::new(0, Arc::new(RateLimiter::new(0)))).await.is_ok());
        });
    }

    #[test]
    fn a_cancelled_download_resumes_without_refetching_what_it_has() {
        tauri::async_runtime::block_on(async {
            let server = Server::new(TEN_MIB, true);
            let url = serve(server.clone()).await;
            let tmp = TempDir::new("resume");
            let client = test_client();
            let job = job_for(&client, &url, &tmp.0, None).await;

            // Slow enough to stop half way: ~1.25 s for the whole file.
            let first = Transfer::new(8 * 1024 * 1024, Arc::new(RateLimiter::new(0)));
            let watcher = {
                let first = first.clone();
                tauri::async_runtime::spawn(async move {
                    while first.downloaded.load(Ordering::Relaxed) < TEN_MIB as u64 / 2 {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    first.cancel.store(true, Ordering::Relaxed);
                })
            };
            assert!(matches!(transfer(&client, &job, &first).await, Err(Halt::Cancelled)));
            let _ = watcher.await;
            assert!(with_suffix(&job.dest, STATE_SUFFIX).exists(), "state kept for the resume");

            let sent_before = server.bytes_sent.load(Ordering::Relaxed);
            let path = transfer(&client, &job, &Transfer::new(0, Arc::new(RateLimiter::new(0)))).await.unwrap();
            let refetched = server.bytes_sent.load(Ordering::Relaxed) - sent_before;
            assert!(std::fs::read(path).unwrap() == server.body);
            assert!(refetched < TEN_MIB as u64 * 3 / 4, "resume refetched {refetched} bytes of {TEN_MIB}");
        });
    }

    #[test]
    fn a_changed_file_is_downloaded_again_from_the_start() {
        tauri::async_runtime::block_on(async {
            let server = Server::new(TEN_MIB, true);
            let url = serve(server.clone()).await;
            let tmp = TempDir::new("changed");
            let client = test_client();
            let job = job_for(&client, &url, &tmp.0, None).await;
            let first = Transfer::new(8 * 1024 * 1024, Arc::new(RateLimiter::new(0)));
            let stopper = {
                let first = first.clone();
                tauri::async_runtime::spawn(async move {
                    while first.downloaded.load(Ordering::Relaxed) < TEN_MIB as u64 / 3 {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    first.cancel.store(true, Ordering::Relaxed);
                })
            };
            let _ = transfer(&client, &job, &first).await;
            let _ = stopper.await;

            // The server now vouches for a different file.
            *server.etag.lock().unwrap() = "\"v2\"".into();
            let job = job_for(&client, &url, &tmp.0, None).await;
            let path = transfer(&client, &job, &Transfer::new(0, Arc::new(RateLimiter::new(0)))).await.unwrap();
            assert!(std::fs::read(path).unwrap() == server.body);
        });
    }

    #[test]
    fn never_overwrites_an_existing_file() {
        let tmp = TempDir::new("free");
        let wanted = tmp.0.join("disc.iso");
        assert_eq!(free_destination(&wanted), wanted);
        std::fs::write(&wanted, b"x").unwrap();
        assert_eq!(free_destination(&wanted), tmp.0.join("disc (1).iso"));
        std::fs::write(tmp.0.join("disc (1).iso"), b"x").unwrap();
        assert_eq!(free_destination(&wanted), tmp.0.join("disc (2).iso"));
    }

    #[test]
    fn rate_limiter_paces_bytes() {
        tauri::async_runtime::block_on(async {
            let limiter = RateLimiter::new(100_000);
            let started = Instant::now();
            for _ in 0..30 {
                limiter.acquire(10_000).await; // 300 KB at 100 KB/s
            }
            let elapsed = started.elapsed();
            assert!(elapsed >= Duration::from_millis(1800), "too fast: {elapsed:?}");
            assert!(elapsed < Duration::from_secs(5), "too slow: {elapsed:?}");
        });
    }
}
