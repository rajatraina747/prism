//! The download queue, owned by Rust.
//!
//! The queue used to live in the page: React state decided what to start,
//! retried failures with timers, and saved itself to disk. So downloads were
//! scheduled only while the webview ran its timers at full speed, a save that
//! didn't land before a quit meant finished items downloaded again (the
//! journal in finished.rs exists because of that), and Rust had to read the
//! page's own file to know which torrents were still wanted.
//!
//! Now this module holds the queue (saved in the database, store.rs), starts
//! engines as slots free up (queue_rules.rs has every rule), hears their
//! progress and completion directly (`emit_progress`, and `finished::emit`
//! calling `on_complete`), retries, moves finished items to the Library, keeps
//! the Dock's progress and runs "when done". The page is a view: it asks for a
//! snapshot, applies `queue-changed` patches and calls the commands below.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::download_manager::DownloadComplete;
use crate::queue_rules::{self as rules, Item};

/// How long a finished item stays in Transfers before it moves to the Library.
const ARCHIVE_AFTER: Duration = Duration::from_millis(300);
/// Progress alone is saved at most this often (a status change, at once).
const PROGRESS_SAVE_EVERY: Duration = Duration::from_secs(2);
/// The page hears about changes at most this often.
const FLUSH_EVERY: Duration = Duration::from_millis(250);
/// Time-based rules (quiet hours, start times, stalled torrents) re-checked.
const TICK_EVERY: Duration = Duration::from_secs(5);
/// "When done" waits this long, cancellable, before acting.
const WHEN_DONE_SECS: u64 = 60;

#[derive(Default)]
struct Inner {
    items: Vec<Item>,
    /// Runs this manager started whose end it hasn't heard yet.
    running: HashSet<String>,
    /// Torrents paused in place: the engine keeps the handle, so resuming
    /// needs no re-add and no re-check.
    paused_native: HashSet<String>,
    /// For the page: changed ids, removed ids, whether the order moved.
    changed: HashSet<String>,
    removed: Vec<String>,
    order_changed: bool,
    /// Number of the last `queue-changed` patch sent. A snapshot says which
    /// patch it reflects, so the page can drop the ones it already has
    /// (REVIEW 2026-09-28 C-9).
    seq: u64,
    save_now: bool,
    save_soon: bool,
    last_save: Option<Instant>,
    /// What the next save writes (P-1). Kept apart from `changed`/`removed`,
    /// which the page's patches drain four times a second.
    unsaved: HashSet<String>,
    unsaved_removed: HashSet<String>,
    unsaved_order: bool,
    /// Rewrite every row: after loading, and after a save that failed.
    full_save: bool,
    /// Items whose torrent file list or piece map changed since the last
    /// patch. Only these carry them (P-4).
    files_changed: HashSet<String>,
    /// When each item reached completed/failed/canceled.
    terminal_since: HashMap<String, Instant>,
    when_done: rules::WhenDone,
    shown_progress: Option<Option<(u64, bool)>>,
    applied_limits: Option<(Option<u64>, Option<u64>, Option<u64>)>,
}

impl Inner {
    fn find(&mut self, id: &str) -> Option<&mut Item> {
        self.items.iter_mut().find(|i| rules::id(i) == id)
    }

    /// Record that `id` changed; `shape` = its status (or the set) changed,
    /// which is saved at once.
    fn touched(&mut self, id: &str, shape: bool) {
        self.changed.insert(id.to_string());
        self.unsaved.insert(id.to_string());
        if shape {
            self.save_now = true;
        } else {
            self.save_soon = true;
        }
    }

    /// The order moved, or an item joined: every position is saved again.
    fn reordered(&mut self) {
        self.order_changed = true;
        self.unsaved_order = true;
    }

    /// What the next save writes, clearing it. None when nothing changed.
    fn take_delta(&mut self) -> Option<crate::store::QueueDelta> {
        let position = |at: usize| at as i64;
        if std::mem::take(&mut self.full_save) {
            self.unsaved.clear();
            self.unsaved_removed.clear();
            self.unsaved_order = false;
            return Some(crate::store::QueueDelta::Full(self.items.iter().map(rules::slim_for_saving).collect()));
        }
        if self.unsaved.is_empty() && self.unsaved_removed.is_empty() && !self.unsaved_order {
            return None;
        }
        let unsaved = std::mem::take(&mut self.unsaved);
        let upsert = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, i)| unsaved.contains(rules::id(i)))
            .map(|(at, i)| (rules::id(i).to_string(), position(at), rules::slim_for_saving(i)))
            .collect();
        let positions = std::mem::take(&mut self.unsaved_order)
            .then(|| self.items.iter().enumerate().map(|(at, i)| (rules::id(i).to_string(), position(at))).collect());
        Some(crate::store::QueueDelta::Changes {
            upsert,
            remove: std::mem::take(&mut self.unsaved_removed).into_iter().collect(),
            positions,
        })
    }

    fn remove(&mut self, id: &str) -> Option<Item> {
        let at = self.items.iter().position(|i| rules::id(i) == id)?;
        let item = self.items.remove(at);
        self.removed.push(id.to_string());
        self.changed.remove(id);
        self.unsaved.remove(id);
        self.unsaved_removed.insert(id.to_string());
        self.terminal_since.remove(id);
        self.save_now = true;
        Some(item)
    }
}

pub struct QueueManager {
    inner: Mutex<Inner>,
    /// Bumped to cancel a "when done" countdown.
    when_done_generation: AtomicU64,
    started: std::sync::atomic::AtomicBool,
}

impl QueueManager {
    pub fn new() -> Self {
        QueueManager { inner: Mutex::new(Inner::default()), when_done_generation: AtomicU64::new(0), started: false.into() }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }
}

fn manager(app: &AppHandle) -> Option<tauri::State<'_, QueueManager>> {
    app.try_state::<QueueManager>().filter(|m| m.started.load(Ordering::SeqCst))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ── Settings ─────────────────────────────────────────────────────────────

struct Prefs {
    max_transfers: usize,
    max_torrents: usize,
    retry_budget: u32,
    schedule: rules::Schedule,
    torrent_down: Option<u64>,
    torrent_up: Option<u64>,
    when_done: String,
    when_done_ignores_seeding: bool,
    default_when_complete: String,
    notifications: bool,
}

impl Prefs {
    fn read(app: &AppHandle) -> Self {
        let n = |key: &str, default: u64, max: u64| crate::setting_u64(app, key, default, 0, max);
        let s = |key: &str, default: &str| {
            crate::read_setting(app, key).and_then(|v| v.as_str().map(str::to_string)).unwrap_or_else(|| default.to_string())
        };
        let kbps = |key: &str| Some(n(key, 0, 10_000_000) * 1024).filter(|b| *b > 0);
        Prefs {
            max_transfers: n("maxConcurrentDownloads", 3, 50).max(1) as usize,
            max_torrents: n("maxConcurrentTorrents", 3, 100).max(1) as usize,
            retry_budget: n("defaultRetryCount", 3, 20) as u32,
            schedule: rules::Schedule {
                enabled: crate::setting_bool(app, "scheduleEnabled", false),
                start_hour: n("scheduleStartHour", 8, 23) as u32,
                end_hour: n("scheduleEndHour", 23, 23) as u32,
                pause: s("scheduleMode", "limit") == "pause",
                limit_mbps: n("scheduleLimitMBps", 5, 100_000) as f64,
                days: crate::read_setting(app, "scheduleDays")
                    .and_then(|v| v.as_array().cloned())
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|d| d.as_u64().filter(|d| *d < 7).map(|d| d as u32))
                    .collect(),
            },
            torrent_down: kbps("torrentDownloadLimitKBps"),
            torrent_up: kbps("torrentUploadLimitKBps"),
            when_done: s("whenDoneAction", "nothing"),
            when_done_ignores_seeding: crate::setting_bool(app, "whenDoneIgnoresSeeding", false),
            default_when_complete: s("defaultWhenComplete", "nothing"),
            notifications: crate::setting_bool(app, "notificationsEnabled", true),
        }
    }
}

// ── Starting up ──────────────────────────────────────────────────────────

/// Load the saved queue and start scheduling. Runs once, at launch.
pub fn start(app: &AppHandle) {
    let Some(state) = app.try_state::<QueueManager>() else { return };
    let mut items: Vec<Item> = crate::store::queue_items(app)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_object().cloned())
        .collect();
    rules::after_restart(&mut items);
    // Completions 2.2.x's journal saw that its page never saved (finished.rs).
    rules::apply_finished(&mut items, &crate::finished::take_legacy_entries(app), &crate::store::history_ids(app));
    {
        let mut inner = state.lock();
        inner.items = items;
        inner.save_now = true;
        inner.full_save = true;
    }
    state.started.store(true, Ordering::SeqCst);
    log::info!("queue: loaded {} item(s)", state.lock().items.len());

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_tick = Instant::now() - TICK_EVERY;
        loop {
            if last_tick.elapsed() >= TICK_EVERY {
                last_tick = Instant::now();
                tick(&app);
            }
            archive_due(&app).await;
            flush(&app).await;
            tokio::time::sleep(FLUSH_EVERY).await;
        }
    });
}

// ── Scheduling ───────────────────────────────────────────────────────────

/// Start what may start, and keep the Dock, rate limits and "when done" in
/// step with the queue. Called after every change and every few seconds.
fn tick(app: &AppHandle) {
    let Some(state) = manager(app) else { return };
    let prefs = Prefs::read(app);
    let gate = rules::gate_now(&prefs.schedule);
    let now_utc = chrono::Utc::now();
    let stamp = now_utc.to_rfc3339();

    let (starts, progress, limits, fire) = {
        let mut inner = state.lock();
        let running = inner.running.clone();
        let ids = if gate.block_starts {
            Vec::new()
        } else {
            rules::items_to_start(&inner.items, prefs.max_transfers, prefs.max_torrents, now_utc, |i| {
                !running.contains(rules::id(i)) && !rules::start_blocked(i, now_utc)
            })
        };
        let mut starts = Vec::new();
        for id in ids {
            if let Some(item) = inner.find(&id) {
                if rules::mark_started(item, &stamp) {
                    starts.push(item.clone());
                }
            }
            inner.running.insert(id.clone());
            inner.touched(&id, true);
        }

        let progress = rules::overall_progress(&inner.items);
        let progress = (inner.shown_progress != Some(progress)).then(|| {
            inner.shown_progress = Some(progress);
            progress
        });

        // Session-wide torrent caps: the user's, tightened by quiet hours in
        // throttle mode; direct downloads get the quiet-hours cap live.
        let tighter = |a: Option<u64>, b: Option<u64>| match (a, b) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        let wanted = (tighter(prefs.torrent_down, gate.speed_limit), tighter(prefs.torrent_up, gate.speed_limit), gate.speed_limit);
        let limits = (inner.applied_limits != Some(wanted)).then(|| {
            inner.applied_limits = Some(wanted);
            wanted
        });

        let (when_done, fire) = rules::evaluate_when_done(inner.when_done, &inner.items, &prefs.when_done, prefs.when_done_ignores_seeding);
        let called_off = rules::when_done_called_off(inner.when_done, when_done);
        inner.when_done = when_done;
        if called_off {
            state.when_done_generation.fetch_add(1, Ordering::SeqCst);
            log::info!("when-done: called off, more to download");
            let _ = app.emit("when-done-cancelled", ());
        }
        for item in inner.items.iter().filter(|i| rules::is_terminal(i)).map(|i| rules::id(i).to_string()).collect::<Vec<_>>() {
            inner.terminal_since.entry(item).or_insert_with(Instant::now);
        }
        (starts, progress, limits, fire)
    };

    for item in starts {
        start_engine(app, item, gate.speed_limit);
    }
    if let Some(progress) = progress {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::set_progress(app, progress.map(|p| p.0), progress.is_some_and(|p| p.1)).await;
        });
    }
    if let Some((down, up, direct)) = limits {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let nz = |b: Option<u64>| b.and_then(|b| u32::try_from(b).ok()).and_then(std::num::NonZeroU32::new);
            app.state::<crate::torrent::TorrentManager>().set_rate_limit(nz(down), nz(up)).await;
            let _ = crate::http_engine::set_http_rate_limit(app.clone(), direct.unwrap_or(0)).await;
        });
    }
    if fire {
        start_when_done(app, prefs.when_done);
    }
}

/// yt-dlp's `-o` escaping: a literal `%` is `%%`.
fn ytdlp_literal(s: &str) -> String {
    s.replace('%', "%%")
}

/// sanitizeFilename (src/services/utils.ts): no path separators, no control
/// characters, never empty.
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name.replace(['/', '\\'], "-").chars().filter(|c| !c.is_control()).collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() { "video".into() } else { cleaned.to_string() }
}

fn template_vars(item: &Item) -> Option<crate::template::TemplateVars> {
    let title = rules::setting_str(item, "filename")
        .or_else(|| rules::metadata_str(item, "title"))
        .unwrap_or("")
        .replace("%%", "%");
    let metadata = item.get("metadata");
    serde_json::from_value(json!({
        "title": title,
        "uploader": metadata.and_then(|m| m.get("uploader")),
        "site": metadata.and_then(|m| m.get("source")).and_then(|s| s.get("domain")),
        "resolution": rules::settings(item).and_then(|s| s.get("format")).and_then(|f| f.get("resolution")),
        "date": metadata.and_then(|m| m.get("source")).and_then(|s| s.get("addedAt")),
    }))
    .ok()
}

/// Start an item's engine. Every engine reports back through
/// `emit_progress` and `finished::emit`; a start refused outright is reported
/// here, as a failure.
fn start_engine(app: &AppHandle, item: Item, quiet_hours_limit: Option<u64>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let id = rules::id(&item).to_string();
        let url = rules::source_url(&item).to_string();
        let settings = rules::settings(&item).cloned().unwrap_or_default();
        let st = |k: &str| settings.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        let flag = |k: &str| settings.get(k).and_then(Value::as_bool).unwrap_or(false);
        let dest = st("destination").unwrap_or_else(|| "~/Downloads/Prism".into());
        let speed = quiet_hours_limit.or_else(|| settings.get("speedLimit").and_then(Value::as_u64).filter(|b| *b > 0));
        log::info!("queue: starting {id} ({})", rules::kind(&item));

        let result: Result<(), (String, Option<String>)> = match rules::kind(&item) {
            "torrent" => {
                let only_files = settings.get("selectedFiles").and_then(|v| serde_json::from_value::<Vec<usize>>(v.clone()).ok());
                crate::start_torrent(app.clone(), id.clone(), url, dest, only_files, speed).await.map_err(|e| (e, None))
            }
            "convert" => match serde_json::from_value(json!(st("convertPreset").unwrap_or_else(|| "mp4-h264".into()))) {
                Ok(preset) => {
                    let duration = item.get("metadata").and_then(|m| m.get("duration")).and_then(Value::as_f64).unwrap_or(0.0);
                    crate::convert::convert_file(app.clone(), id.clone(), url, preset, duration).await.map_err(|e| (e, None))
                }
                Err(_) => Err(("Unknown conversion".into(), Some("invalid_input".into()))),
            },
            "direct" => crate::http_engine::start_http_download(
                app.clone(),
                id.clone(),
                url,
                dest,
                st("filename"),
                st("sha256"),
                speed,
                st("filenameTemplate"),
                template_vars(&item),
                st("referer"),
            )
            .await
            .map_err(|e| {
                let code = serde_json::to_value(&e).ok().and_then(|v| v.get("code").and_then(Value::as_str).map(str::to_string));
                (e.summary, code)
            }),
            _ => {
                let name = sanitize_filename(st("filename").as_deref().or(rules::metadata_str(&item, "title")).unwrap_or("video"));
                let output_path = format!("{}/{}.%(ext)s", ytdlp_literal(&dest), ytdlp_literal(&name));
                let audio_only = flag("audioOnly");
                let format = settings.get("format");
                crate::start_download(
                    app.clone(),
                    id.clone(),
                    url,
                    output_path,
                    if audio_only { None } else { format.and_then(|f| f.get("id")).and_then(Value::as_str).map(str::to_string) },
                    Some(audio_only),
                    Some(flag("downloadSubtitles")),
                    st("subtitleLanguage"),
                    speed,
                    format.and_then(|f| f.get("fileSize")).and_then(Value::as_u64).filter(|s| *s > 0),
                    Some(dest),
                    st("filenameTemplate"),
                    template_vars(&item),
                    st("clipStart"),
                    st("clipEnd"),
                    Some(flag("splitChapters")),
                    Some(!flag("noCookies")),
                    st("audioLanguage"),
                    Some(flag("embedSubtitles")),
                    Some(flag("useArchive")),
                    st("referer"),
                )
                .await
                .map_err(|e| (e, None))
            }
        };
        match result {
            Err((message, code)) => {
                log::warn!("queue: {id} didn't start: {message}");
                on_failure(&app, &id, &message, code.as_deref(), None);
            }
            // The engine holds its own ticket once its start call returns, so
            // a stop from here on reaches it. One that came earlier — while the
            // start checked the folder and disk space — found nothing to stop,
            // and the engine ran on for a paused or cancelled item (REVIEW
            // 2026-09-28 C-2). Look again now.
            Ok(()) if stopped_while_starting(&app, &id) => {
                log::info!("queue: {id} was stopped while it started");
                stop_engine(&app, &id).await;
            }
            Ok(()) => {}
        }
    });
}

/// Whether the user paused, cancelled or removed `id` after the queue
/// started it. Queued isn't: that is a resume, with a new start on its way.
fn stopped_while_starting(app: &AppHandle, id: &str) -> bool {
    let Some(state) = manager(app) else { return false };
    let mut inner = state.lock();
    match inner.find(id).map(|i| &*i) {
        Some(item) => rules::was_stopped(item),
        None => true,
    }
}

/// Where Rust keeps the `-o` template a video item's run actually claimed
/// (after de-duplication, so `Title (1)` when that is what ran) and when it
/// was first claimed. Only `record_claim` writes it; `queue_add` strips any
/// the page sends. Cancelling a paused item deletes by this record, never by
/// a path rebuilt from the item's settings (REVIEW 2026-09-28 D-1, C-3).
pub(crate) const CLAIM: &str = "engineClaim";

/// Record the template a yt-dlp run claimed for `id`. A restart that claims
/// the same template keeps the first time, so the files its earlier runs
/// wrote still count as its own.
pub(crate) fn record_claim(app: &AppHandle, id: &str, template: &str) {
    let _ = update(app, id, |i| {
        if claim_of(i).is_some_and(|(t, _)| t == template) {
            return false;
        }
        // File times can be coarse (2 s on FAT); step back so the run's very
        // first write isn't taken for an older file.
        let since = std::time::SystemTime::now() - Duration::from_secs(2);
        let since_ms = since.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        i.insert(CLAIM.into(), json!({ "template": template, "sinceMs": since_ms }));
        true
    });
}

/// The claimed template and since-when, if a run ever claimed one.
fn claim_of(item: &Item) -> Option<(String, std::time::SystemTime)> {
    let claim = item.get(CLAIM)?;
    let template = claim.get("template")?.as_str()?.to_string();
    let since = std::time::UNIX_EPOCH + Duration::from_millis(claim.get("sinceMs")?.as_u64()?);
    Some((template, since))
}

/// Cancel, not pause: stop whatever engine runs `id` and delete what it
/// wrote (Windows test run 2026-09-26: cancelled downloads left `.part`
/// files, a preallocated 1 GB `.prismpart`, and empty torrent folders).
async fn discard_engine(app: &AppHandle, id: &str, item: Option<Item>) {
    // Torrent first: it marks the discard before anything cancels the id's
    // job ticket. A start still fetching metadata reads the mark when it sees
    // the cancel; the other engines cancelling first made it keep its folder.
    app.state::<crate::torrent::TorrentManager>().cancel_torrent(app, id, true).await;
    app.state::<crate::DownloadManager>().discard_download(id).await;
    crate::http_engine::discard_http_download(app, id).await;
    let _ = crate::convert::cancel_convert(id.to_string()).await;
    // A paused video isn't running: its files are found from the claim its
    // run recorded. A stopped magnet's (empty) folder is found from the item,
    // so its destination must pass the same check a download start does.
    if let Some(i) = item.as_ref().filter(|i| rules::kind(i) == "torrent") {
        let dest = rules::setting_str(i, "destination").unwrap_or("~/Downloads/Prism").to_string();
        let url = rules::source_url(i).to_string();
        if let Ok(dest) = crate::validate_download_path(&dest, &crate::picked_dirs(app)) {
            let cfg = crate::torrent_session_config(app);
            app.state::<crate::torrent::TorrentManager>().discard_stopped(app, &dest, &url, &cfg).await;
        }
    }
    // (yt-dlp items are kind "http", the default; direct links are "direct".)
    // Only what a run of this item claimed: an item that never started wrote
    // nothing, and its settings are not a path to delete from.
    if let Some((template, since)) = item.filter(|i| rules::kind(i) == "http").as_ref().and_then(claim_of) {
        let _ = tauri::async_runtime::spawn_blocking(move || crate::download_manager::discard_stopped(&template, since)).await;
    }
    if let Some(state) = manager(app) {
        let mut inner = state.lock();
        inner.running.remove(id);
        inner.paused_native.remove(id);
    }
}

/// Stop whatever engine runs `id` (each is a no-op for an id it doesn't own).
async fn stop_engine(app: &AppHandle, id: &str) {
    let _ = crate::cancel_download(app.clone(), id.to_string()).await;
    let _ = crate::cancel_torrent(app.clone(), id.to_string(), Some(false)).await;
    let _ = crate::http_engine::cancel_http_download(app.clone(), id.to_string()).await;
    let _ = crate::convert::cancel_convert(id.to_string()).await;
    if let Some(state) = manager(app) {
        let mut inner = state.lock();
        inner.running.remove(id);
        inner.paused_native.remove(id);
    }
}

// ── What engines report ──────────────────────────────────────────────────

/// Engines emit progress through here, into the queue; the page hears it in
/// the queue's patches. (A per-item `download-progress-{id}` event went out
/// too, serialised a second time, and nothing on the desktop listened to it:
/// REVIEW 2026-09-28 P-5.)
pub fn emit_progress<T: Serialize>(app: &AppHandle, id: &str, payload: &T) {
    let Some(state) = manager(app) else { return };
    let Ok(value) = serde_json::to_value(payload) else { return };
    let (data, seeding) = rules::progress_fields(&value);
    let mut inner = state.lock();
    // The torrent poll resends the list every few seconds; only a different
    // one counts (a seeding torrent's never changes).
    let files_differ = inner.find(id).is_some_and(|item| {
        ["files", "pieces"].iter().any(|k| data.get(*k).is_some_and(|new| item.get(*k) != Some(new)))
    });
    if files_differ {
        inner.files_changed.insert(id.to_string());
    }
    let Some(item) = inner.find(id) else { return };
    let was = rules::status(item).to_string();
    if rules::apply_progress(item, &data, seeding) {
        let now_seeding = rules::status(item) != was;
        let listed = now_seeding.then(|| {
            let item = item.clone();
            Archived { history: rules::seeding_entry(&item, &now()), item: Value::Object(item), stage: "seeding" }
        });
        inner.touched(id, now_seeding);
        if let Some(entry) = listed {
            drop(inner);
            // Listed in the Library now, not when seeding ends (which can
            // take days); and its download slot is free.
            list_in_library(app, vec![entry]);
            tick(app);
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Notice {
    /// 'completed' | 'failed' | 'skipped' | 'quality'
    kind: &'static str,
    id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    engine_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    requested: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    actual: Option<u32>,
}

fn title_of(item: &Item) -> String {
    rules::metadata_str(item, "title").unwrap_or("Download").to_string()
}

/// The main window is in front of someone: a toast will be seen.
fn window_in_front(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
}

fn os_notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

fn notice(app: &AppHandle, n: Notice, notifications: bool) {
    if notifications && !window_in_front(app) {
        match n.kind {
            "completed" => os_notify(app, "Download complete", &n.title),
            "failed" => os_notify(app, "Download failed", &n.title),
            _ => {}
        }
    }
    let _ = app.emit("queue-notice", n);
}

/// A run ended (`finished::emit`).
pub fn on_complete(app: &AppHandle, complete: &DownloadComplete) {
    if manager(app).is_none() {
        return;
    }
    if complete.success {
        on_success(app, complete);
    } else {
        let error = complete.error.as_ref().and_then(|e| serde_json::to_value(e).ok());
        let message = error.as_ref().and_then(|e| e.get("summary")).and_then(Value::as_str).unwrap_or("Download failed").to_string();
        let code = error.as_ref().and_then(|e| e.get("code")).and_then(Value::as_str).map(str::to_string);
        let detail = error.as_ref().and_then(|e| e.get("detail")).and_then(Value::as_str).map(str::to_string);
        on_failure(app, &complete.id, &message, code.as_deref(), detail.as_deref());
    }
}

fn on_success(app: &AppHandle, complete: &DownloadComplete) {
    let Some(state) = manager(app) else { return };
    let prefs = Prefs::read(app);
    let finish = rules::Finish {
        completed_at: now(),
        file_path: complete.file_path.clone(),
        file_size: complete.file_size,
        actual_height: complete.actual_height,
        output_folder: complete.output_folder.clone(),
    };
    let done = {
        let mut inner = state.lock();
        inner.running.remove(&complete.id);
        inner.paused_native.remove(&complete.id);
        let Some(item) = inner.find(&complete.id) else { return };
        if !rules::complete(item, &finish) {
            return;
        }
        let item = item.clone();
        inner.touched(&complete.id, true);
        inner.terminal_since.insert(complete.id.clone(), Instant::now());
        item
    };
    save_now(app);
    let title = title_of(&done);
    let requested = rules::settings(&done)
        .and_then(|s| s.get("format"))
        .and_then(|f| f.get("resolution"))
        .and_then(Value::as_str)
        .and_then(|r| r.trim_end_matches('p').parse::<u32>().ok());
    notice(app, Notice { kind: "completed", id: complete.id.clone(), title: title.clone(), message: None, engine_code: None, requested: None, actual: None }, prefs.notifications);
    if let (Some(actual), Some(requested)) = (complete.actual_height, requested) {
        if actual < requested {
            let _ = app.emit("queue-notice", Notice { kind: "quality", id: complete.id.clone(), title: title.clone(), message: None, engine_code: None, requested: Some(requested), actual: Some(actual) });
        }
    }
    // Whatever was asked for this download in particular, else the default.
    let after = rules::setting_str(&done, "whenComplete").map(str::to_string).unwrap_or(prefs.default_when_complete);
    let target = complete
        .file_path
        .clone()
        .or_else(|| complete.output_folder.clone())
        .or_else(|| rules::setting_str(&done, "destination").map(str::to_string));
    match (after.as_str(), target) {
        ("notify", _) => os_notify(app, "Download complete", &title),
        ("open", Some(path)) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { let _ = crate::open_file(app, path).await; });
        }
        ("reveal", Some(path)) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { let _ = crate::show_in_folder(app, path).await; });
        }
        _ => {}
    }
    tick(app);
}

fn on_failure(app: &AppHandle, id: &str, message: &str, code: Option<&str>, detail: Option<&str>) {
    let Some(state) = manager(app) else { return };
    let prefs = Prefs::read(app);
    let category = rules::classify(code, message).category;
    let mut retry_in = None;
    let mut retry_at = String::new();
    let failed = {
        let mut inner = state.lock();
        inner.running.remove(id);
        inner.paused_native.remove(id);
        // A subscription video yt-dlp's archive says was downloaded before:
        // nothing failed, and nothing new arrived.
        if code == Some("already_downloaded") {
            if let Some(item) = inner.remove(id) {
                log::info!("queue: skipped, already downloaded: {}", title_of(&item));
            }
            None
        } else {
            let Some(item) = inner.find(id) else { return };
            if !matches!(rules::status(item), "downloading" | "queued") {
                return;
            }
            let attempt = rules::num(item, "retryAttempt") as u32;
            retry_in = rules::retry_delay_ms(attempt, prefs.retry_budget, category, code, message);
            if let Some(delay) = retry_in {
                // Holds its slot while it waits: a pause or cancel meanwhile wins.
                let at = chrono::Utc::now() + chrono::Duration::milliseconds(delay as i64);
                let reason = rules::classify(code, message).suggestion;
                retry_at = at.to_rfc3339();
                if rules::mark_retry_wait(item, &retry_at, reason) {
                    inner.touched(id, true);
                }
                None
            } else {
                rules::fail(item, rules::error_record(message, code, detail, &now()));
                let item = item.clone();
                inner.touched(id, true);
                inner.terminal_since.insert(id.to_string(), Instant::now());
                Some(item)
            }
        }
    };
    if let Some(delay) = retry_in {
        log::warn!("queue: {id} failed ({message}); retrying in {} s", delay / 1000);
        let (app, id) = (app.clone(), id.to_string());
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            if let Some(state) = manager(&app) {
                let mut inner = state.lock();
                if let Some(item) = inner.find(&id) {
                    // Only the wait this timer was set for: a pause, resume or
                    // Retry since then cleared it, and a newer failure set its
                    // own (REVIEW 2026-09-28 D-2).
                    if rules::requeue_for_retry(item, &retry_at) {
                        inner.touched(&id, true);
                    }
                }
            }
            tick(&app);
        });
        return;
    }
    if failed.is_some() {
        save_now(app);
    }
    if let Some(item) = failed {
        notice(
            app,
            Notice {
                kind: "failed",
                id: id.to_string(),
                title: title_of(&item),
                message: Some(message.to_string()),
                engine_code: code.map(str::to_string),
                requested: None,
                actual: None,
            },
            prefs.notifications,
        );
    }
    tick(app);
}

// ── Moving finished items to the Library ─────────────────────────────────

#[derive(Serialize, Clone)]
struct Archived {
    history: Value,
    item: Value,
    /// "final" when the item left the queue (count it); "seeding" for a
    /// torrent listed while it seeds, "update" for that entry changing.
    stage: &'static str,
}

/// Write Library entries without taking anything out of the queue: a
/// torrent listed when it starts seeding, or that entry updated.
fn list_in_library(app: &AppHandle, entries: Vec<Archived>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let rows: Vec<Value> = entries.iter().map(|e| e.history.clone()).collect();
        let handle = app.clone();
        let saved = tauri::async_runtime::spawn_blocking(move || crate::store::add_history(&handle, &rows)).await;
        if matches!(saved, Ok(Ok(()))) {
            let _ = app.emit("queue-archived", entries);
        } else {
            log::warn!("queue: couldn't list a seeding torrent in the Library");
        }
    });
}

async fn archive_due(app: &AppHandle) {
    let Some(state) = manager(app) else { return };
    let due: Vec<Item> = {
        let inner = state.lock();
        inner
            .items
            .iter()
            .filter(|i| rules::is_terminal(i))
            .filter(|i| inner.terminal_since.get(rules::id(i)).is_some_and(|t| t.elapsed() >= ARCHIVE_AFTER))
            .cloned()
            .collect()
    };
    if due.is_empty() {
        return;
    }
    let stamp = now();
    let entries: Vec<Archived> = due
        .iter()
        .map(|i| Archived { history: rules::history_entry(i, &stamp), item: Value::Object(i.clone()), stage: "final" })
        .collect();
    let rows: Vec<Value> = entries.iter().map(|e| e.history.clone()).collect();
    let saved = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || crate::store::add_history(&app, &rows)).await
    };
    if !matches!(saved, Ok(Ok(()))) {
        log::warn!("queue: couldn't move finished items to the Library; will try again");
        return;
    }
    {
        let mut inner = state.lock();
        for item in &due {
            // Still finished: a Retry during the Library write restarted it,
            // and removing it then left its engine running with no row.
            if inner.items.iter().any(|i| rules::id(i) == rules::id(item) && rules::is_terminal(i)) {
                inner.remove(rules::id(item));
            }
        }
    }
    let _ = app.emit("queue-archived", entries);
}

// ── Telling the page, and saving ─────────────────────────────────────────

/// Save the queue now, not at the next flush: a completion that isn't on
/// disk when Prism is quit (or killed) would download again next launch —
/// the bug the old finished journal existed for (REVIEW 2026-09-23 B-1).
/// Write whatever is unsaved, on this thread. For quitting.
pub fn save_on_exit(app: &AppHandle) {
    persist(app);
}

fn save_now(app: &AppHandle) {
    // On the blocking pool, not the async worker that reported the
    // completion: a playlist finishing in a burst wrote the database N times
    // back to back on those workers (REVIEW 2026-09-28 P-2).
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || persist(&app));
}

/// Write what changed since the last save. One at a time, and the changes
/// are taken inside that turn, so saves land in the order they were taken:
/// an older delta can never be written over a newer one. Blocking.
fn persist(app: &AppHandle) {
    static SAVING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _turn = SAVING.lock().unwrap_or_else(|p| p.into_inner());
    let Some(state) = manager(app) else { return };
    let delta = {
        let mut inner = state.lock();
        inner.save_now = false;
        inner.save_soon = false;
        inner.last_save = Some(Instant::now());
        inner.take_delta()
    };
    let Some(delta) = delta else { return };
    if let Err(e) = crate::store::save_queue_delta(app, &delta) {
        log::warn!("queue: save failed ({e}); will write everything next time");
        let mut inner = state.lock();
        inner.full_save = true;
        inner.save_now = true;
    }
}

#[derive(Serialize, Clone)]
struct Patch {
    seq: u64,
    items: Vec<Value>,
    removed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    order: Option<Vec<String>>,
}

async fn flush(app: &AppHandle) {
    let Some(state) = manager(app) else { return };
    let (patch, save) = {
        let mut inner = state.lock();
        let patch = (!inner.changed.is_empty() || !inner.removed.is_empty() || inner.order_changed).then(|| {
            let changed = std::mem::take(&mut inner.changed);
            let files_changed = std::mem::take(&mut inner.files_changed);
            // A torrent's file list and piece map go only when they changed:
            // with thousands of files they were hundreds of KB, sent with
            // every speed update, once a second (REVIEW 2026-09-28 P-4). The
            // page keeps the copy it has when a patch leaves them out.
            let items = inner
                .items
                .iter()
                .filter(|i| changed.contains(rules::id(i)))
                .map(|i| {
                    let mut item = i.clone();
                    if !files_changed.contains(rules::id(i)) {
                        item.remove("files");
                        item.remove("pieces");
                    }
                    Value::Object(item)
                })
                .collect();
            let order = std::mem::take(&mut inner.order_changed)
                .then(|| inner.items.iter().map(|i| rules::id(i).to_string()).collect());
            inner.seq += 1;
            Patch { seq: inner.seq, items, removed: std::mem::take(&mut inner.removed), order }
        });
        let due = inner.save_now || (inner.save_soon && inner.last_save.map_or(true, |t| t.elapsed() >= PROGRESS_SAVE_EVERY));
        (patch, due)
    };
    if let Some(patch) = patch {
        let _ = app.emit("queue-changed", patch);
    }
    if save {
        let handle = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || persist(&handle)).await;
    }
}

// ── When everything finishes ─────────────────────────────────────────────

fn start_when_done(app: &AppHandle, action: String) {
    let Some(state) = manager(app) else { return };
    let generation = state.when_done_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit("when-done-countdown", json!({ "action": action, "seconds": WHEN_DONE_SECS }));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(WHEN_DONE_SECS)).await;
        let Some(state) = manager(&app) else { return };
        let still_idle = {
            let ignore_seeding = crate::setting_bool(&app, "whenDoneIgnoresSeeding", false);
            !state.lock().items.iter().any(|i| rules::is_busy(i, ignore_seeding))
        };
        if state.when_done_generation.load(Ordering::SeqCst) == generation && still_idle {
            log::info!("when-done: {action}");
            let _ = crate::when_done(app, action).await;
        }
    });
}

#[tauri::command]
pub async fn when_done_cancel(app: AppHandle) {
    if let Some(state) = manager(&app) {
        state.when_done_generation.fetch_add(1, Ordering::SeqCst);
        log::info!("when-done: cancelled");
    }
}

// ── Commands (the page's actions) ────────────────────────────────────────
//
// All async: a synchronous Tauri command runs on the main thread, and these
// each run a scheduling pass — adding a 500-video playlist did 500 of them on
// the thread that draws the window (REVIEW 2026-09-28 P-3).

fn require(app: &AppHandle) -> Result<tauri::State<'_, QueueManager>, String> {
    manager(app).ok_or_else(|| "The queue isn't ready yet".to_string())
}

/// Apply `f` to one item; true if it changed.
fn update(app: &AppHandle, id: &str, f: impl FnOnce(&mut Item) -> bool) -> Result<bool, String> {
    let state = require(app)?;
    let mut inner = state.lock();
    let changed = inner.find(id).map(f).unwrap_or(false);
    if changed {
        inner.touched(id, true);
    }
    Ok(changed)
}

/// A destination the page hands in must be one a download may start in: the
/// same check every engine makes at start, made at the door so nothing ever
/// acts on an item with a destination no download could have used (D-1).
fn check_destination(app: &AppHandle, settings: &serde_json::Map<String, Value>) -> Result<(), String> {
    match settings.get("destination").and_then(Value::as_str).filter(|d| !d.is_empty()) {
        Some(dest) => crate::validate_download_path(dest, &crate::picked_dirs(app)).map(|_| ()),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn queue_snapshot(app: AppHandle) -> Result<Value, String> {
    let state = require(&app)?;
    let inner = state.lock();
    // Changes not yet flushed are in `items` already and come again in patch
    // `seq + 1`, whole, so applying that one too is harmless.
    let items: Vec<Value> = inner.items.iter().map(|i| Value::Object(i.clone())).collect();
    Ok(json!({ "items": items, "seq": inner.seq }))
}

#[tauri::command]
pub async fn queue_add(app: AppHandle, item: Value) -> Result<(), String> {
    let mut item = item.as_object().cloned().ok_or("Not a queue item")?;
    if rules::id(&item).is_empty() {
        return Err("A queue item needs an id".into());
    }
    // Rust's own records are Rust's to write (D-1).
    item.remove(CLAIM);
    if let Some(settings) = rules::settings(&item) {
        check_destination(&app, settings)?;
    }
    item.entry("addedAt").or_insert_with(|| json!(now()));
    {
        let state = require(&app)?;
        let mut inner = state.lock();
        let id = rules::id(&item).to_string();
        if inner.find(&id).is_some() {
            return Ok(());
        }
        inner.items.push(item);
        inner.reordered();
        inner.touched(&id, true);
    }
    tick(&app);
    Ok(())
}

#[tauri::command]
pub async fn queue_remove(app: AppHandle, id: String) -> Result<(), String> {
    // Asked before stopping it: a seeding torrent reports itself completed
    // the moment its engine lets go.
    let was_seeding = require(&app)?.lock().find(&id).is_some_and(|i| rules::status(i) == "seeding");
    stop_engine(&app, &id).await;
    let removed = require(&app)?.lock().remove(&id);
    // A torrent removed while seeding stays in the Library, no longer seeding.
    if let Some(item) = removed.filter(|_| was_seeding) {
        let mut history = rules::seeding_entry(&item, &now());
        history["seeding"] = json!(false);
        list_in_library(&app, vec![Archived { history, item: Value::Object(item), stage: "update" }]);
    }
    tick(&app);
    Ok(())
}

#[tauri::command]
pub async fn queue_pause(app: AppHandle, id: String) -> Result<(), String> {
    let (torrent_live, status) = {
        let state = require(&app)?;
        let mut inner = state.lock();
        let running = inner.running.contains(&id);
        let item = inner.find(&id).ok_or("Not in the queue")?;
        (rules::kind(item) == "torrent" && running, rules::status(item).to_string())
    };
    // A running torrent pauses in place, keeping its handle; everything
    // else (and a torrent that won't pause) is stopped and started again.
    let mut native = false;
    if torrent_live && matches!(status.as_str(), "downloading" | "seeding") {
        native = app.state::<crate::torrent::TorrentManager>().pause_torrent(&id).await.is_ok();
    }
    if native {
        require(&app)?.lock().paused_native.insert(id.clone());
    } else {
        stop_engine(&app, &id).await;
    }
    // Only start/finish/fail used to be logged, which left gaps in a report
    // (Windows test run 2026-09-26).
    log::info!("queue: {id} paused{}", if native { " (in place)" } else { "" });
    update(&app, &id, rules::pause)?;
    tick(&app);
    Ok(())
}

#[tauri::command]
pub async fn queue_resume(app: AppHandle, id: String) -> Result<(), String> {
    log::info!("queue: {id} resumed");
    let native = require(&app)?.lock().paused_native.contains(&id);
    if native {
        if app.state::<crate::torrent::TorrentManager>().resume_torrent(&id).await.is_ok() {
            require(&app)?.lock().paused_native.remove(&id);
            let stamp = now();
            update(&app, &id, |i| {
                let started = i.get("startedAt").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| stamp.clone());
                rules::resume(i) && rules::mark_started(i, &started)
            })?;
            tick(&app);
            return Ok(());
        }
        // The engine lost the handle: start it afresh.
        stop_engine(&app, &id).await;
    }
    update(&app, &id, rules::resume)?;
    tick(&app);
    Ok(())
}

#[tauri::command]
pub async fn queue_cancel(app: AppHandle, id: String) -> Result<(), String> {
    let seeding = {
        let state = require(&app)?;
        let mut inner = state.lock();
        inner.find(&id).is_some_and(|i| rules::status(i) == "seeding")
    };
    if seeding {
        // Stopping a seed is a success, not a cancel: the engine reports the
        // finished torrent as completed.
        let _ = crate::cancel_torrent(app.clone(), id, Some(false)).await;
        return Ok(());
    }
    let item = require(&app)?.lock().find(&id).cloned();
    discard_engine(&app, &id, item).await;
    log::info!("queue: {id} cancelled");
    update(&app, &id, rules::cancel)?;
    tick(&app);
    Ok(())
}

#[tauri::command]
pub async fn queue_retry(app: AppHandle, id: String) -> Result<(), String> {
    stop_engine(&app, &id).await;
    {
        let state = require(&app)?;
        let mut inner = state.lock();
        inner.terminal_since.remove(&id);
    }
    update(&app, &id, rules::retry)?;
    tick(&app);
    Ok(())
}

#[tauri::command]
pub async fn queue_pause_all(app: AppHandle) -> Result<(), String> {
    let ids: Vec<String> = require(&app)?
        .lock()
        .items
        .iter()
        .filter(|i| matches!(rules::status(i), "downloading" | "seeding"))
        .map(|i| rules::id(i).to_string())
        .collect();
    for id in ids {
        queue_pause(app.clone(), id).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn queue_resume_all(app: AppHandle) -> Result<(), String> {
    let ids: Vec<String> =
        require(&app)?.lock().items.iter().filter(|i| rules::status(i) == "paused").map(|i| rules::id(i).to_string()).collect();
    for id in ids {
        queue_resume(app.clone(), id).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn queue_clear_completed(app: AppHandle) -> Result<(), String> {
    let state = require(&app)?;
    let mut inner = state.lock();
    let done: Vec<String> = inner.items.iter().filter(|i| rules::status(i) == "completed").map(|i| rules::id(i).to_string()).collect();
    for id in done {
        inner.remove(&id);
    }
    Ok(())
}

#[tauri::command]
pub async fn queue_reorder(app: AppHandle, from: usize, to: usize) -> Result<(), String> {
    let state = require(&app)?;
    let mut inner = state.lock();
    if from >= inner.items.len() {
        return Ok(());
    }
    let item = inner.items.remove(from);
    let to = to.min(inner.items.len());
    inner.items.insert(to, item);
    inner.reordered();
    inner.save_now = true;
    drop(inner);
    tick(&app);
    Ok(())
}

/// Replace an item's settings — worked out by the page with the same rules
/// it always used (category, labels, checksum, start time, clip) — while it
/// is still in `only_if` (when given). A download that started meanwhile
/// keeps what it started with.
#[tauri::command]
pub async fn queue_set_settings(app: AppHandle, id: String, settings: Value, only_if: Option<String>) -> Result<bool, String> {
    let Some(fields) = settings.as_object() else {
        return Err("Settings must be an object".into());
    };
    check_destination(&app, fields)?;
    let changed = update(&app, &id, |i| {
        if only_if.as_deref().is_some_and(|s| s != rules::status(i)) {
            return false;
        }
        i.insert("settings".into(), settings);
        true
    })?;
    tick(&app);
    Ok(changed)
}

#[tauri::command]
pub async fn queue_update_torrent_files(app: AppHandle, id: String, files: Vec<usize>) -> Result<(), String> {
    app.state::<crate::torrent::TorrentManager>().update_file_selection(&id, files.clone()).await?;
    update(&app, &id, |i| {
        if let Some(settings) = i.get_mut("settings").and_then(Value::as_object_mut) {
            settings.insert("selectedFiles".into(), json!(files));
        }
        true
    })?;
    Ok(())
}

#[tauri::command]
pub async fn queue_remove_with_data(app: AppHandle, id: String) -> Result<(), String> {
    {
        let state = require(&app)?;
        let mut inner = state.lock();
        inner.running.remove(&id);
        inner.paused_native.remove(&id);
        inner.remove(&id);
    }
    crate::cancel_torrent(app.clone(), id.clone(), Some(true)).await?;
    // Its files are gone: so is the entry listed while it seeded.
    let handle = app.clone();
    let gone = id.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || crate::store::remove_history(&handle, &gone)).await;
    let _ = app.emit("library-removed", vec![id]);
    tick(&app);
    Ok(())
}

/// Restart the torrent engine so its settings apply now (R4.6): running
/// torrents pause, the engine restarts, and they go back in line to adopt
/// their restored torrents without re-checking.
#[tauri::command]
pub async fn queue_restart_torrent_engine(app: AppHandle) -> Result<usize, String> {
    let resume: Vec<String> = {
        let state = require(&app)?;
        let mut inner = state.lock();
        let watched: Vec<String> = inner
            .items
            .iter()
            .filter(|i| rules::kind(i) == "torrent")
            .map(|i| rules::id(i).to_string())
            .filter(|id| inner.running.contains(id))
            .collect();
        let mut resume = Vec::new();
        for id in watched {
            inner.running.remove(&id);
            inner.paused_native.remove(&id);
            if let Some(item) = inner.find(&id) {
                if matches!(rules::status(item), "downloading" | "seeding") {
                    rules::pause(item);
                    rules::resume(item);
                    resume.push(id.clone());
                }
            }
            inner.touched(&id, true);
        }
        resume
    };
    let was_running = app.state::<crate::torrent::TorrentManager>().restart().await;
    log::info!("queue: torrent engine restarted; {} torrent(s) go back in line", resume.len());
    tick(&app);
    Ok(was_running)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(v: Value) -> Item {
        v.as_object().cloned().unwrap()
    }

    // Regression (REVIEW 2026-09-28 D-1): a paused item's Cancel deletes by
    // what a run claimed, never by a path rebuilt from its settings — a
    // planted `destination` names nothing to delete.
    #[test]
    fn a_cancel_deletes_only_by_the_claim_rust_recorded() {
        let planted = item(json!({
            "id": "x",
            "status": "paused",
            "settings": { "destination": "~/Documents", "filename": "thesis" },
            "metadata": { "source": { "addedAt": "1970-01-01T00:00:00Z" } },
        }));
        assert!(claim_of(&planted).is_none(), "never started: nothing of its own to delete");

        let ran = item(json!({
            "id": "y",
            "settings": { "destination": "~/Documents" },
            CLAIM: { "template": "/dl/Clip (1).%(ext)s", "sinceMs": 1_000 },
        }));
        let (template, since) = claim_of(&ran).unwrap();
        assert_eq!(template, "/dl/Clip (1).%(ext)s", "the de-duplicated name the run used (C-3)");
        assert_eq!(since, std::time::UNIX_EPOCH + Duration::from_secs(1));
    }
}
