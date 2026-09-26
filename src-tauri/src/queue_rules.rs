//! The queue's rules, pure: what each event does to an item, which items may
//! start, when quiet hours hold them, how a failure is classified and retried,
//! when the "when done" action fires, what the Dock shows, and what an item
//! becomes in the Library.
//!
//! These were the page's (src/stores/queue-reducer.ts, schedule.ts, slots.ts,
//! retry.ts, completion.ts, progress.ts, errors.ts, finished.ts); they moved
//! here with the queue itself (queue.rs), so downloads are scheduled whether
//! or not a window is open. The TypeScript copies stay for the browser demo,
//! and these tests are theirs, ported.
//!
//! Items are the page's JSON (`serde_json::Map`): the page owns their shape,
//! and these rules touch only the fields they are about, leaving every other
//! field exactly as it came.

use chrono::{DateTime, Datelike, Timelike, Utc};
use serde_json::{json, Map, Value};

pub type Item = Map<String, Value>;

// ── Field access ─────────────────────────────────────────────────────────

pub fn id(item: &Item) -> &str {
    item.get("id").and_then(Value::as_str).unwrap_or("")
}

pub fn status(item: &Item) -> &str {
    item.get("status").and_then(Value::as_str).unwrap_or("")
}

pub fn kind(item: &Item) -> &str {
    item.get("kind").and_then(Value::as_str).unwrap_or("http")
}

pub fn num(item: &Item, key: &str) -> f64 {
    item.get(key).and_then(Value::as_f64).filter(|v| v.is_finite()).unwrap_or(0.0)
}

pub fn settings(item: &Item) -> Option<&Item> {
    item.get("settings").and_then(Value::as_object)
}

pub fn setting_str<'a>(item: &'a Item, key: &str) -> Option<&'a str> {
    settings(item).and_then(|s| s.get(key)).and_then(Value::as_str).filter(|s| !s.is_empty())
}

pub fn metadata_str<'a>(item: &'a Item, key: &str) -> Option<&'a str> {
    item.get("metadata").and_then(Value::as_object).and_then(|m| m.get(key)).and_then(Value::as_str)
}

pub fn source_url(item: &Item) -> &str {
    item.get("metadata")
        .and_then(|m| m.get("source"))
        .and_then(|s| s.get("url"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn set(item: &mut Item, key: &str, value: Value) {
    item.insert(key.to_string(), value);
}

fn is(item: &Item, statuses: &[&str]) -> bool {
    statuses.contains(&status(item))
}

// ── Transitions (queue-reducer.ts) ───────────────────────────────────────
//
// Guard principle: user intent wins races. An event from an engine applies
// only while the item is still in the state that event is about; if someone
// paused, cancelled or removed it meanwhile, the event is ignored. Each
// returns whether the item changed.

/// Reset on retry and requeue. Keeps totalBytes (a retried torrent must not
/// fall back to a placeholder size), uploaded bytes, ratio, files and pieces.
fn reset_counters(item: &mut Item) {
    for (key, value) in [("progress", 0), ("downloadedBytes", 0), ("speed", 0), ("eta", 0), ("peerlessSecs", 0)] {
        set(item, key, json!(value));
    }
    item.remove("stage");
}

fn stop_counters(item: &mut Item) {
    set(item, "speed", json!(0));
    set(item, "eta", json!(0));
}

pub fn mark_started(item: &mut Item, now: &str) -> bool {
    if status(item) != "queued" {
        return false;
    }
    set(item, "status", json!("downloading"));
    set(item, "startedAt", json!(now));
    true
}

/// Merge an engine's progress (already in the item's own field names). A
/// torrent that reports `seeding` moves to 'seeding' and never back.
pub fn apply_progress(item: &mut Item, data: &Item, seeding: bool) -> bool {
    match status(item) {
        "downloading" => {
            for (k, v) in data {
                if v.is_null() {
                    item.remove(k);
                } else {
                    item.insert(k.clone(), v.clone());
                }
            }
            if seeding {
                set(item, "status", json!("seeding"));
            }
            true
        }
        "seeding" => {
            for (k, v) in data {
                if v.is_null() {
                    item.remove(k);
                } else {
                    item.insert(k.clone(), v.clone());
                }
            }
            true
        }
        _ => false,
    }
}

/// What an engine reports when a run ends well.
#[derive(Debug, Default, Clone)]
pub struct Finish {
    pub completed_at: String,
    pub file_path: Option<String>,
    pub file_size: Option<u64>,
    pub actual_height: Option<u32>,
    pub output_folder: Option<String>,
}

pub fn complete(item: &mut Item, finish: &Finish) -> bool {
    if !is(item, &["downloading", "seeding"]) {
        return false;
    }
    set(item, "status", json!("completed"));
    set(item, "progress", json!(100));
    stop_counters(item);
    set(item, "uploadSpeed", json!(0));
    set(item, "completedAt", json!(finish.completed_at));
    match &finish.file_path {
        Some(p) => set(item, "filePath", json!(p)),
        None => {
            item.remove("filePath");
        }
    }
    match finish.actual_height {
        Some(h) => set(item, "actualHeight", json!(h)),
        None => {
            item.remove("actualHeight");
        }
    }
    if let Some(folder) = &finish.output_folder {
        set(item, "outputFolder", json!(folder));
    }
    if let Some(size) = finish.file_size {
        set(item, "totalBytes", json!(size));
    }
    true
}

/// 'queued' is included for a start that failed before it was marked
/// started; pause and cancel still win.
pub fn fail(item: &mut Item, error: Value) -> bool {
    if !is(item, &["downloading", "queued"]) {
        return false;
    }
    set(item, "status", json!("failed"));
    stop_counters(item);
    set(item, "error", error);
    true
}

pub fn requeue_for_retry(item: &mut Item) -> bool {
    if status(item) != "downloading" {
        return false;
    }
    set(item, "status", json!("queued"));
    let attempt = num(item, "retryAttempt") as u64 + 1;
    set(item, "retryAttempt", json!(attempt));
    reset_counters(item);
    item.remove("error");
    true
}

pub fn pause(item: &mut Item) -> bool {
    if !is(item, &["queued", "downloading", "seeding"]) {
        return false;
    }
    set(item, "status", json!("paused"));
    stop_counters(item);
    set(item, "uploadSpeed", json!(0));
    true
}

pub fn resume(item: &mut Item) -> bool {
    if status(item) != "paused" {
        return false;
    }
    set(item, "status", json!("queued"));
    true
}

pub fn cancel(item: &mut Item) -> bool {
    if status(item) == "completed" {
        return false;
    }
    set(item, "status", json!("canceled"));
    stop_counters(item);
    true
}

/// A retry by hand starts a fresh automatic-retry budget.
pub fn retry(item: &mut Item) -> bool {
    set(item, "status", json!("queued"));
    set(item, "retryAttempt", json!(0));
    reset_counters(item);
    item.remove("error");
    true
}

pub fn is_terminal(item: &Item) -> bool {
    is(item, &["completed", "failed", "canceled"])
}

// ── Starting (slots.ts, schedule.ts) ─────────────────────────────────────

pub const SLOW_TORRENT_SECS: f64 = 300.0;
pub const SLOW_TORRENT_BPS: f64 = 1024.0;

fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|t| t.with_timezone(&Utc))
}

/// A running torrent stalled long enough not to hold a slot (qBittorrent's
/// "don't count slow torrents").
pub fn is_slow_torrent(item: &Item, now: DateTime<Utc>) -> bool {
    if kind(item) != "torrent" || status(item) != "downloading" {
        return false;
    }
    if num(item, "peerlessSecs") >= SLOW_TORRENT_SECS {
        return true;
    }
    let running_for = item
        .get("startedAt")
        .and_then(Value::as_str)
        .and_then(parse_time)
        .map(|t| (now - t).num_seconds() as f64)
        .unwrap_or(0.0);
    running_for >= SLOW_TORRENT_SECS && num(item, "speed") < SLOW_TORRENT_BPS
}

/// An item waiting for its own start time. A stamp that won't parse lets it
/// start rather than stranding it.
pub fn start_blocked(item: &Item, now: DateTime<Utc>) -> bool {
    setting_str(item, "startAt").and_then(parse_time).is_some_and(|at| at > now)
}

/// Queued items to start now, in queue order, within each pool's free
/// slots: torrents apart from everything else.
pub fn items_to_start(items: &[Item], transfers: usize, torrents: usize, now: DateTime<Utc>, startable: impl Fn(&Item) -> bool) -> Vec<String> {
    let (mut free_transfers, mut free_torrents) = (transfers as i64, torrents as i64);
    for item in items.iter().filter(|i| status(i) == "downloading") {
        if kind(item) == "torrent" {
            if !is_slow_torrent(item, now) {
                free_torrents -= 1;
            }
        } else {
            free_transfers -= 1;
        }
    }
    let mut picked = Vec::new();
    for item in items.iter().filter(|i| status(i) == "queued" && startable(i)) {
        let pool = if kind(item) == "torrent" { &mut free_torrents } else { &mut free_transfers };
        if *pool > 0 {
            *pool -= 1;
            picked.push(id(item).to_string());
        }
    }
    picked
}

/// The quiet-hours settings.
#[derive(Debug, Clone, Default)]
pub struct Schedule {
    pub enabled: bool,
    pub start_hour: u32,
    pub end_hour: u32,
    /// "pause" holds new downloads; "limit" starts them throttled.
    pub pause: bool,
    pub limit_mbps: f64,
    /// 0 = Sunday … 6; empty = every day.
    pub days: Vec<u32>,
}

/// Inside [start, end), handling an overnight wrap; start == end is never.
pub fn in_quiet_hours(hour: u32, start: u32, end: u32) -> bool {
    if start == end {
        return false;
    }
    if start < end {
        hour >= start && hour < end
    } else {
        hour >= start || hour < end
    }
}

/// An overnight window belongs to the day it began on.
pub fn window_start_day(weekday_from_sunday: u32, hour: u32, start: u32, end: u32) -> u32 {
    if start > end && hour < start {
        (weekday_from_sunday + 6) % 7
    } else {
        weekday_from_sunday
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Gate {
    pub block_starts: bool,
    /// Bytes/sec a start is throttled to.
    pub speed_limit: Option<u64>,
}

pub const OPEN: Gate = Gate { block_starts: false, speed_limit: None };

/// Quiet hours at a local time (`hour`, weekday counted from Sunday).
pub fn gate(schedule: &Schedule, hour: u32, weekday_from_sunday: u32) -> Gate {
    if !schedule.enabled || !in_quiet_hours(hour, schedule.start_hour, schedule.end_hour) {
        return OPEN;
    }
    if !schedule.days.is_empty()
        && !schedule.days.contains(&window_start_day(weekday_from_sunday, hour, schedule.start_hour, schedule.end_hour))
    {
        return OPEN;
    }
    if schedule.pause {
        Gate { block_starts: true, speed_limit: None }
    } else {
        Gate { block_starts: false, speed_limit: Some((schedule.limit_mbps.max(1.0) * 1024.0 * 1024.0) as u64) }
    }
}

pub fn gate_now(schedule: &Schedule) -> Gate {
    let now = chrono::Local::now();
    gate(schedule, now.hour(), now.weekday().num_days_from_sunday())
}

// ── Failures (errors.ts, retry.ts) ───────────────────────────────────────

/// How a failure is filed, and what to suggest.
pub struct Classified {
    pub category: &'static str,
    pub suggestion: &'static str,
}

const CHECK_CONNECTION: Classified = Classified { category: "network", suggestion: "Check your connection, then retry" };
const SIGN_IN: Classified = Classified {
    category: "auth",
    suggestion: "This video needs you to be signed in — choose a browser where you're logged in under Browser cookies",
};
const GONE: Classified = Classified { category: "parse", suggestion: "This video is no longer available" };
const REGION: Classified = Classified { category: "parse", suggestion: "Not available in your region" };
const RATE: Classified = Classified { category: "network", suggestion: "Rate limited by the site — wait a few minutes, then retry" };
const REFUSED: Classified = Classified {
    category: "unknown",
    suggestion: "The site refused the download — update the engine in Settings → Updates, then retry",
};
const NO_WRITE: Classified = Classified {
    category: "permission",
    suggestion: "Prism can't write there — pick another download folder in Settings → Storage",
};
const DISK: Classified = Classified { category: "storage", suggestion: "Free up disk space, then retry" };
const QUALITY: Classified = Classified { category: "unknown", suggestion: "Try a different quality" };
const UNSUPPORTED: Classified = Classified { category: "parse", suggestion: "This link may not be supported" };

/// Classify by the engine's code, else (older engines, `unknown`) by message.
pub fn classify(code: Option<&str>, message: &str) -> Classified {
    match code {
        Some("auth") => return SIGN_IN,
        Some("unavailable") => return GONE,
        Some("geo") => return REGION,
        Some("rate_limited") => return RATE,
        Some("forbidden") => return REFUSED,
        Some("disk_full") => return DISK,
        Some("permission") => return NO_WRITE,
        Some("format") => return QUALITY,
        Some("timeout") | Some("network") => return CHECK_CONNECTION,
        Some("unsupported") | Some("not_found") => return UNSUPPORTED,
        Some("checksum") => {
            return Classified {
                category: "unknown",
                suggestion: "The file didn't match its expected checksum — retry, or check the checksum you entered",
            }
        }
        Some("invalid_input") => return Classified { category: "parse", suggestion: "Check the link and your proxy settings" },
        Some("engine_missing") => return Classified { category: "unknown", suggestion: "Prism's downloader is missing — reinstall Prism" },
        Some("busy") => return Classified { category: "unknown", suggestion: "Prism is busy — try again in a moment" },
        Some("cancelled") => return Classified { category: "unknown", suggestion: "The download was stopped" },
        _ => {}
    }
    let m = message.to_ascii_lowercase();
    let any = |words: &[&str]| words.iter().any(|w| m.contains(w));
    if any(&["sign in to confirm", "not a bot", "login required", "private video", "members-only", "age-restricted", "age restricted", "confirm your age", "cookies"]) {
        SIGN_IN
    } else if any(&["video unavailable", "has been removed", "account terminated", "no longer available", "404"]) {
        GONE
    } else if any(&["available in your country", "geo restrict", "georestrict"]) {
        REGION
    } else if any(&["429", "too many requests", "rate limit"]) {
        RATE
    } else if any(&["403", "forbidden"]) {
        REFUSED
    } else if any(&["permission", "access denied"]) {
        NO_WRITE
    } else if any(&["disk", "space", "no space", "full"]) {
        DISK
    } else if any(&["codec", "format", "merge", "remux"]) {
        QUALITY
    } else if any(&["timeout", "timed out", "connection", "network", "dns", "ssl", "unable to download"]) {
        CHECK_CONNECTION
    } else if any(&["not found", "unsupported", "unable to extract"]) {
        UNSUPPORTED
    } else {
        // Unknown must not be 'network': that category retries on its own.
        Classified { category: "unknown", suggestion: "Check the link, then retry" }
    }
}

/// How long to wait before an automatic retry, or None to report the
/// failure. `attempt` automatic retries have run; `budget` is the "Retries
/// on failure" setting. A rate limit waits minutes, not seconds.
pub fn retry_delay_ms(attempt: u32, budget: u32, category: &str, code: Option<&str>, message: &str) -> Option<u64> {
    if attempt >= budget {
        return None;
    }
    let m = message.to_ascii_lowercase();
    let rate_limited = code == Some("rate_limited")
        || m.contains("429")
        || m.contains("too many requests")
        || m.contains("rate limit")
        || m.contains("ratelimit");
    if rate_limited {
        const WAITS: [u64; 3] = [60_000, 5 * 60_000, 15 * 60_000];
        return Some(WAITS[(attempt as usize).min(WAITS.len() - 1)]);
    }
    if code == Some("busy") {
        return Some(10_000);
    }
    if category == "network" {
        return Some((5_000u64 << attempt.min(10)).min(60_000));
    }
    None
}

/// The item's error record, as the Library and the tooltip read it.
pub fn error_record(message: &str, code: Option<&str>, detail: Option<&str>, now: &str) -> Value {
    let c = classify(code, message);
    let mut error = json!({
        "code": "DOWNLOAD_FAILED",
        "message": message,
        "category": c.category,
        "timestamp": now,
        "suggestion": c.suggestion,
    });
    if let Some(code) = code {
        error["engineCode"] = json!(code);
    }
    if let Some(detail) = detail.filter(|d| !d.is_empty()) {
        error["detail"] = json!(detail);
    }
    error
}

// ── When everything finishes (completion.ts) ─────────────────────────────

/// Whether an item still needs Prism awake. Paused doesn't count (it never
/// finishes on its own); seeding does unless the setting waives it.
pub fn is_busy(item: &Item, ignore_seeding: bool) -> bool {
    match status(item) {
        "queued" | "parsing" | "ready" | "downloading" => true,
        "seeding" => !ignore_seeding,
        _ => false,
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct WhenDone {
    pub was_busy: bool,
    pub armed: bool,
}

/// Fires once, on the move from busy to idle — never from a standing start,
/// so switching the setting on with an empty queue doesn't sleep the machine.
pub fn evaluate_when_done(prev: WhenDone, items: &[Item], action: &str, ignore_seeding: bool) -> (WhenDone, bool) {
    if action == "nothing" {
        return (WhenDone::default(), false);
    }
    if items.iter().any(|i| is_busy(i, ignore_seeding)) {
        return (WhenDone { was_busy: true, armed: false }, false);
    }
    if prev.was_busy && !prev.armed {
        return (WhenDone { was_busy: false, armed: true }, true);
    }
    (if prev.armed { prev } else { WhenDone::default() }, false)
}

// ── The Dock / taskbar (progress.ts) ─────────────────────────────────────

/// (percent, paused), or None when nothing is under way. Weighted by bytes
/// when every working item knows its size, else the mean of percentages.
pub fn overall_progress(items: &[Item]) -> Option<(u64, bool)> {
    let clamp = |v: f64| if v.is_finite() { v.round().clamp(0.0, 100.0) as u64 } else { 0 };
    let mean = |list: &[&Item]| {
        if list.is_empty() {
            0
        } else {
            clamp(list.iter().map(|i| num(i, "progress")).sum::<f64>() / list.len() as f64)
        }
    };
    let working: Vec<&Item> = items.iter().filter(|i| is(i, &["downloading", "queued", "parsing", "ready"])).collect();
    if working.is_empty() {
        let paused: Vec<&Item> = items.iter().filter(|i| status(i) == "paused").collect();
        return (!paused.is_empty()).then(|| (mean(&paused), true));
    }
    if !working.iter().all(|i| num(i, "totalBytes") > 0.0) {
        return Some((mean(&working), false));
    }
    let done: f64 = working.iter().map(|i| num(i, "downloadedBytes")).sum();
    let total: f64 = working.iter().map(|i| num(i, "totalBytes")).sum();
    Some((clamp(done / total * 100.0), false))
}

// ── The Library ──────────────────────────────────────────────────────────

/// What a finished item becomes in the Library (HistoryItem).
pub fn history_entry(item: &Item, now: &str) -> Value {
    let st = status(item);
    let mut entry = json!({
        "id": id(item),
        "metadata": item.get("metadata").cloned().unwrap_or(Value::Null),
        "settings": item.get("settings").cloned().unwrap_or(Value::Null),
        "status": st,
        "completedAt": item.get("completedAt").and_then(Value::as_str).unwrap_or(now),
        "fileSize": if st == "completed" { num(item, "totalBytes") } else { num(item, "downloadedBytes") },
    });
    let e = entry.as_object_mut().expect("object");
    if num(item, "totalBytes") > 0.0 {
        e.insert("totalBytes".into(), json!(num(item, "totalBytes")));
    }
    for key in ["filePath", "error", "actualHeight", "outputFolder"] {
        if let Some(v) = item.get(key).filter(|v| !v.is_null()) {
            e.insert(key.into(), v.clone());
        }
    }
    // Torrents keep their file list (capped), so the Library can play each.
    if kind(item) == "torrent" && st == "completed" {
        if let Some(files) = item.get("files").and_then(Value::as_array).filter(|f| !f.is_empty()) {
            let slim: Vec<Value> = files.iter().take(500).map(|f| json!({"name": f.get("name"), "size": f.get("size")})).collect();
            e.insert("files".into(), Value::Array(slim));
        }
    }
    entry
}

/// The Library entry for a torrent that has finished downloading and is
/// seeding: listed now (its files are there to play), marked so, and
/// replaced by the final entry when seeding ends.
pub fn seeding_entry(item: &Item, now: &str) -> Value {
    let mut copy = item.clone();
    copy.insert("status".into(), json!("completed"));
    copy.entry("completedAt").or_insert_with(|| json!(now));
    let mut entry = history_entry(&copy, now);
    entry["seeding"] = json!(true);
    entry
}

/// A torrent's file list and pieces map are runtime detail; they come back
/// with the next progress tick and aren't saved.
pub fn slim_for_saving(item: &Item) -> Value {
    let mut copy = item.clone();
    copy.remove("files");
    copy.remove("pieces");
    Value::Object(copy)
}

/// An engine's progress payload, in the item's own field names.
pub fn progress_fields(payload: &Value) -> (Item, bool) {
    let p = payload.as_object().cloned().unwrap_or_default();
    let mut out = Item::new();
    for (from, to) in [
        ("downloaded_bytes", "downloadedBytes"),
        ("total_bytes", "totalBytes"),
        ("progress", "progress"),
        ("speed", "speed"),
        ("eta", "eta"),
        ("upload_speed", "uploadSpeed"),
        ("peers", "peers"),
        ("peers_seen", "peersSeen"),
        ("peers_connecting", "peersConnecting"),
        ("ratio", "ratio"),
        ("uploaded_bytes", "uploadedBytes"),
        ("peerless_secs", "peerlessSecs"),
        ("files", "files"),
        ("pieces", "pieces"),
        ("output_folder", "outputFolder"),
        ("file_path", "filePath"),
    ] {
        if let Some(v) = p.get(from) {
            out.insert(to.into(), v.clone());
        }
    }
    // Present even when absent: a stage ends (null clears it).
    out.insert("stage".into(), p.get("stage").cloned().unwrap_or(Value::Null));
    let seeding = p.get("seeding").and_then(Value::as_bool).unwrap_or(false);
    (out, seeding)
}

/// The saved queue as it comes back after a restart, when nothing is running.
/// A torrent that was seeding goes back in line too: re-added, it adopts its
/// data without re-checking and seeds on by its policy (it used to sit inert,
/// still saying "seeding").
pub fn after_restart(items: &mut [Item]) {
    for item in items.iter_mut() {
        if is(item, &["downloading", "seeding"]) {
            set(item, "status", json!("queued"));
        }
        stop_counters(item);
    }
}

// ── Engines' finished journal (finished.ts) ──────────────────────────────

/// Mark queued items the engines saw finish (a save that didn't land before
/// a quit). Items the Library already holds are dropped instead.
pub fn apply_finished(items: &mut Vec<Item>, finished: &[Value], in_library: &std::collections::HashSet<String>) {
    let by_id: std::collections::HashMap<&str, &Value> =
        finished.iter().filter_map(|f| Some((f.get("id")?.as_str()?, f))).collect();
    items.retain(|i| !(by_id.contains_key(id(i)) && in_library.contains(id(i)) && !is_terminal(i)));
    for item in items.iter_mut() {
        let Some(done) = by_id.get(id(item)) else { continue };
        if is_terminal(item) {
            continue;
        }
        set(item, "status", json!("completed"));
        set(item, "progress", json!(100));
        stop_counters(item);
        set(item, "uploadSpeed", json!(0));
        for (from, to) in [("completedAt", "completedAt"), ("filePath", "filePath"), ("fileSize", "totalBytes"), ("outputFolder", "outputFolder")] {
            if let Some(v) = done.get(from).filter(|v| !v.is_null()) {
                item.insert(to.into(), v.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, status: &str, extra: Value) -> Item {
        let mut i = json!({
            "id": id, "status": status, "progress": 0, "speed": 0, "eta": 0,
            "downloadedBytes": 0, "totalBytes": 0, "retryAttempt": 0,
            "metadata": {"title": id, "source": {"url": format!("https://x/{id}")}},
            "settings": {"destination": "/d", "filename": id},
        })
        .as_object()
        .unwrap()
        .clone();
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            i.insert(k, v);
        }
        i
    }

    // ── transitions (queue-reducer.test.ts) ──

    #[test]
    fn engine_events_only_apply_to_the_state_they_are_about() {
        let mut paused = item("a", "paused", json!({}));
        assert!(!complete(&mut paused, &Finish::default()), "user pause wins over a late completion");
        assert!(!fail(&mut paused, json!({})));
        assert!(!requeue_for_retry(&mut paused));
        assert_eq!(status(&paused), "paused");

        let mut running = item("a", "downloading", json!({"totalBytes": 10}));
        let finish = Finish { completed_at: "t".into(), file_path: Some("/d/a.mp4".into()), file_size: Some(99), ..Default::default() };
        assert!(complete(&mut running, &finish));
        assert_eq!(status(&running), "completed");
        assert_eq!(running["filePath"], "/d/a.mp4");
        assert_eq!(running["totalBytes"], 99);
        assert_eq!(running["progress"], 100);
    }

    #[test]
    fn a_torrent_moves_to_seeding_and_never_back() {
        let mut t = item("t", "downloading", json!({"kind": "torrent"}));
        let (data, seeding) = progress_fields(&json!({"progress": 100, "downloaded_bytes": 5, "seeding": true}));
        assert!(apply_progress(&mut t, &data, seeding));
        assert_eq!(status(&t), "seeding");
        let (data, seeding) = progress_fields(&json!({"progress": 100, "upload_speed": 9, "seeding": false}));
        assert!(apply_progress(&mut t, &data, seeding));
        assert_eq!(status(&t), "seeding");
        assert_eq!(t["uploadSpeed"], 9);
    }

    #[test]
    fn progress_clears_a_finished_stage_and_keeps_the_file_list_between_ticks() {
        let mut i = item("a", "downloading", json!({"stage": "processing", "files": [{"name": "x"}]}));
        let (data, _) = progress_fields(&json!({"progress": 50}));
        apply_progress(&mut i, &data, false);
        assert!(!i.contains_key("stage"));
        assert_eq!(i["files"], json!([{"name": "x"}]));
    }

    #[test]
    fn retries_reset_counters_and_budgets() {
        let mut i = item("a", "downloading", json!({"progress": 40, "downloadedBytes": 400, "totalBytes": 1000, "retryAttempt": 1}));
        assert!(requeue_for_retry(&mut i));
        assert_eq!((status(&i), i["retryAttempt"].as_u64(), i["progress"].as_u64(), i["totalBytes"].as_u64()), ("queued", Some(2), Some(0), Some(1000)));
        let mut failed = item("a", "failed", json!({"retryAttempt": 2, "error": {"message": "x"}}));
        retry(&mut failed);
        assert_eq!((status(&failed), failed["retryAttempt"].as_u64()), ("queued", Some(0)));
        assert!(!failed.contains_key("error"));
    }

    #[test]
    fn pause_resume_cancel() {
        let mut i = item("a", "downloading", json!({"speed": 5}));
        assert!(pause(&mut i));
        assert_eq!((status(&i), i["speed"].as_u64()), ("paused", Some(0)));
        assert!(resume(&mut i));
        assert_eq!(status(&i), "queued");
        assert!(cancel(&mut i));
        assert_eq!(status(&i), "canceled");
        let mut done = item("b", "completed", json!({}));
        assert!(!cancel(&mut done), "a finished download stays finished");
    }

    // ── slots (slots.test.ts) ──

    fn now() -> DateTime<Utc> {
        parse_time("2026-09-26T12:00:00Z").unwrap()
    }

    #[test]
    fn stalled_torrents_no_longer_block_a_video() {
        let mut items: Vec<Item> = (0..3)
            .map(|n| item(&format!("t{n}"), "downloading", json!({"kind": "torrent", "peerlessSecs": 300, "startedAt": "2026-09-26T11:45:00Z"})))
            .collect();
        items.push(item("v", "queued", json!({"kind": "http"})));
        assert_eq!(items_to_start(&items, 3, 3, now(), |_| true), ["v"]);
    }

    #[test]
    fn separate_pools_and_the_startable_filter() {
        let items = vec![
            item("t0", "downloading", json!({"kind": "torrent", "speed": 500000, "startedAt": "2026-09-26T11:59:00Z"})),
            item("t1", "queued", json!({"kind": "torrent"})),
            item("t2", "queued", json!({"kind": "torrent"})),
            item("v1", "queued", json!({})),
            item("d1", "queued", json!({"kind": "direct"})),
        ];
        assert_eq!(items_to_start(&items, 1, 2, now(), |_| true), ["t1", "v1"]);
        assert_eq!(items_to_start(&items, 3, 3, now(), |i| id(i) != "v1"), ["t1", "t2", "d1"]);
    }

    #[test]
    fn a_start_time_holds_only_its_item() {
        let later = item("a", "queued", json!({"settings": {"startAt": "2026-09-26T13:00:00Z"}}));
        let garbage = item("b", "queued", json!({"settings": {"startAt": "tomorrow-ish"}}));
        assert!(start_blocked(&later, now()));
        assert!(!start_blocked(&garbage, now()), "an unreadable time never strands a download");
    }

    // ── quiet hours (schedule.test.ts) ──

    #[test]
    fn quiet_hours_wrap_midnight_and_belong_to_the_night_they_began() {
        assert!(in_quiet_hours(23, 22, 6) && in_quiet_hours(3, 22, 6) && !in_quiet_hours(12, 22, 6));
        assert!(!in_quiet_hours(5, 5, 5));
        // Monday night 22:00 → Tuesday 03:00 is still Monday's window.
        assert_eq!(window_start_day(2, 3, 22, 6), 1);
        let s = Schedule { enabled: true, start_hour: 22, end_hour: 6, pause: false, limit_mbps: 2.0, days: vec![1] };
        assert_eq!(gate(&s, 3, 2), Gate { block_starts: false, speed_limit: Some(2 * 1024 * 1024) });
        assert_eq!(gate(&s, 3, 3), OPEN, "Tuesday night isn't chosen");
        let hold = Schedule { pause: true, ..s };
        assert!(gate(&hold, 23, 1).block_starts);
    }

    // ── failures (errors.test.ts, retry.test.ts) ──

    #[test]
    fn classifies_by_code_then_message() {
        assert_eq!(classify(Some("auth"), "").category, "auth");
        assert_eq!(classify(None, "ERROR: Sign in to confirm you're not a bot").category, "auth");
        assert_eq!(classify(Some("unknown"), "HTTP Error 429: Too Many Requests").category, "network");
        assert_eq!(classify(None, "something odd").category, "unknown");
    }

    #[test]
    fn retries_follow_the_budget_and_wait_longer_for_rate_limits() {
        assert_eq!(retry_delay_ms(0, 3, "network", Some("network"), ""), Some(5_000));
        assert_eq!(retry_delay_ms(1, 3, "network", Some("timeout"), ""), Some(10_000));
        assert_eq!(retry_delay_ms(8, 10, "network", Some("timeout"), ""), Some(60_000));
        assert_eq!(retry_delay_ms(3, 3, "network", Some("network"), ""), None);
        assert_eq!(retry_delay_ms(0, 5, "network", Some("rate_limited"), ""), Some(60_000));
        assert_eq!(retry_delay_ms(4, 5, "network", None, "429 Too Many Requests"), Some(900_000));
        assert_eq!(retry_delay_ms(0, 3, "unknown", Some("busy"), ""), Some(10_000));
        assert_eq!(retry_delay_ms(0, 3, "auth", Some("auth"), ""), None);
    }

    // ── when done (completion.test.ts) ──

    #[test]
    fn when_done_fires_once_and_only_after_real_work() {
        let busy = vec![item("a", "downloading", json!({}))];
        let idle = vec![item("a", "completed", json!({}))];
        let (s, fire) = evaluate_when_done(WhenDone::default(), &idle, "sleep", false);
        assert!(!fire, "a standing start never fires");
        let (s, fire) = evaluate_when_done(s, &busy, "sleep", false);
        assert!(!fire);
        let (s, fire) = evaluate_when_done(s, &idle, "sleep", false);
        assert!(fire);
        let (_, fire) = evaluate_when_done(s, &idle, "sleep", false);
        assert!(!fire, "once");
        let seeding = vec![item("t", "seeding", json!({}))];
        assert!(!evaluate_when_done(WhenDone { was_busy: true, armed: false }, &seeding, "sleep", false).1);
        assert!(evaluate_when_done(WhenDone { was_busy: true, armed: false }, &seeding, "sleep", true).1);
    }

    // ── progress (progress.test.ts) ──

    #[test]
    fn dock_progress_weights_by_bytes_when_it_can() {
        let items = vec![
            item("a", "downloading", json!({"downloadedBytes": 90, "totalBytes": 100, "progress": 90})),
            item("b", "downloading", json!({"downloadedBytes": 0, "totalBytes": 900, "progress": 0})),
        ];
        assert_eq!(overall_progress(&items), Some((9, false)));
        let unknown = vec![item("a", "downloading", json!({"progress": 50})), item("b", "queued", json!({"progress": 0}))];
        assert_eq!(overall_progress(&unknown), Some((25, false)));
        assert_eq!(overall_progress(&[item("a", "paused", json!({"progress": 40}))]), Some((40, true)));
        assert_eq!(overall_progress(&[item("a", "completed", json!({}))]), None);
    }

    // ── the Library ──

    #[test]
    fn a_finished_torrent_keeps_its_files_in_the_library() {
        let t = item("t", "completed", json!({"kind": "torrent", "totalBytes": 10, "files": [{"name": "a.mkv", "size": 10, "progress": 1}], "filePath": "/d/a.mkv"}));
        let h = history_entry(&t, "now");
        assert_eq!(h["files"], json!([{"name": "a.mkv", "size": 10}]));
        assert_eq!(h["fileSize"], 10.0);
        assert_eq!(h["completedAt"], "now");
        let failed = item("f", "failed", json!({"downloadedBytes": 4, "error": {"message": "x"}}));
        assert_eq!(history_entry(&failed, "t")["fileSize"], 4.0);
    }

    #[test]
    fn after_a_restart_running_work_goes_back_in_line() {
        let mut items = vec![
            item("a", "downloading", json!({"speed": 9, "progress": 40})),
            item("t", "seeding", json!({"kind": "torrent"})),
            item("p", "paused", json!({})),
            item("c", "completed", json!({})),
        ];
        after_restart(&mut items);
        let states: Vec<(&str, &str)> = items.iter().map(|i| (id(i), status(i))).collect();
        assert_eq!(states, [("a", "queued"), ("t", "queued"), ("p", "paused"), ("c", "completed")]);
        assert_eq!((items[0]["speed"].as_u64(), items[0]["progress"].as_u64()), (Some(0), Some(40)), "progress kept for the resume");
    }

    #[test]
    fn a_seeding_torrent_is_listed_as_seeding() {
        let t = item("t", "seeding", json!({"kind": "torrent", "totalBytes": 10, "filePath": "/d/a.mkv", "files": [{"name": "a.mkv", "size": 10}]}));
        let e = seeding_entry(&t, "now");
        assert_eq!((e["status"].as_str(), e["seeding"].as_bool(), e["filePath"].as_str()), (Some("completed"), Some(true), Some("/d/a.mkv")));
        assert_eq!(e["files"], json!([{"name": "a.mkv", "size": 10}]));
    }

    #[test]
    fn the_finished_journal_completes_items_once() {
        let mut items = vec![item("a", "queued", json!({})), item("b", "queued", json!({})), item("c", "failed", json!({}))];
        let finished = vec![json!({"id": "a", "completedAt": "t", "filePath": "/d/a"}), json!({"id": "b", "completedAt": "t"}), json!({"id": "c", "completedAt": "t"})];
        let library: std::collections::HashSet<String> = ["b".to_string()].into_iter().collect();
        apply_finished(&mut items, &finished, &library);
        assert_eq!(items.iter().map(|i| (id(i), status(i))).collect::<Vec<_>>(), [("a", "completed"), ("c", "failed")]);
        assert_eq!(items[0]["filePath"], "/d/a");
    }
}
