//! BitTorrent engine. Wraps librqbit behind a `TorrentManager` that mirrors
//! `download_manager::DownloadManager`: it emits the same `download-progress-{id}` /
//! `download-complete-{id}` events so torrents flow through the existing queue, plus
//! torrent-only swarm stats and a `seeding` flag. See ROADMAP.md → "Second engine".
//!
//! Trust boundary: file names inside a torrent come from untrusted metadata. Writes
//! are confined to `output_folder` and librqbit is responsible for rejecting
//! path-traversal (`../`) entries — we never join those names ourselves except for
//! the top-level torrent name (also librqbit-provided) when resolving an open path.

use std::collections::HashMap;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use librqbit::api::TorrentIdOrHash;
use librqbit::limits::LimitsConfig;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, ManagedTorrent, Session, SessionOptions,
    TorrentStatsState,
};

use crate::download_manager::DownloadComplete;

/// Fixed listen-port range so the UPnP mapping and DHT stay stable across runs.
const TORRENT_PORT_RANGE: std::ops::Range<u16> = 4240..4260;

const BYTES_PER_MIB: f64 = 1024.0 * 1024.0;

/// How long a torrent may make zero download progress before we call it stalled.
/// Mirrors the HTTP engine's inactivity kill; a live seeding torrent is exempt
/// (it's `finished`, handled separately).
const STALL_TIMEOUT_SECS: u64 = 300;

/// Re-send the (static) file list at most this often — per-file progress refreshes
/// on this cadence while the cheap top-line stats update every second.
const FILE_LIST_EMIT_EVERY_SECS: u64 = 5;

/// librqbit's handle type (not re-exported at the crate root in 8.x).
type ManagedTorrentHandle = Arc<ManagedTorrent>;

// ── TorrentManager ───────────────────────────────────────────────────────

/// What to do once a torrent finishes downloading. Sourced from the user's
/// `seedingPolicy` setting (see lib::seeding_policy).
#[derive(Clone, Copy)]
pub enum SeedingPolicy {
    /// Stop uploading the moment the download completes.
    Stop,
    /// Seed until the share ratio (uploaded / downloaded) reaches the target.
    Ratio(f64),
    /// Seed until the user stops the item manually.
    Forever,
}

/// One entry in a multi-file torrent. Field names are single words so they map
/// 1:1 to the frontend model with no camelCase translation.
#[derive(Clone, Serialize)]
pub struct TorrentFile {
    pub name: String,
    pub size: u64,
    pub progress: f64,
}

/// A file listed from a torrent's metadata before downloading — used by the
/// file-selection modal. `index` is what librqbit's `only_files` expects.
#[derive(Clone, Serialize)]
pub struct TorrentFileEntry {
    pub index: usize,
    pub name: String,
    pub size: u64,
}

/// Progress payload. Field names match download_manager::DownloadProgress so the
/// frontend's existing listener reads the shared fields, plus torrent-only extras.
#[derive(Clone, Serialize)]
pub struct TorrentProgress {
    pub id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub progress: f64,
    pub speed: f64,
    pub eta: f64,
    pub upload_speed: f64,
    pub peers: u32,
    pub ratio: f64,
    pub seeding: bool,
    /// The torrent's files with per-file progress. Omitted (not just empty) on
    /// ticks where we don't re-send the list, so the frontend keeps the last one.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<TorrentFile>,
}

type SessionSlot = Arc<Mutex<Option<Arc<Session>>>>;

/// Cap on cached parsed-torrent metadata so parsing many torrents without
/// downloading them can't grow memory without bound.
const RESOLVED_CACHE_CAP: usize = 16;

pub struct TorrentManager {
    /// One librqbit session for the whole app, created lazily on first torrent.
    session: SessionSlot,
    /// Active torrents by queue id. Removal is the cancel signal for the poll loop.
    active: Arc<Mutex<HashMap<String, ManagedTorrentHandle>>>,
    /// Session-wide rate limits (download + upload). Applied at session creation
    /// and updated live — this is how Quiet Hours throttles torrents.
    limits: Arc<Mutex<LimitsConfig>>,
    /// `.torrent` bytes resolved by `list_files`, keyed by source URL, so
    /// `start_torrent` can add from bytes instead of re-fetching magnet metadata
    /// from peers. Consumed (removed) on use.
    resolved: Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

/// Lazily create and cache the shared librqbit session. Enables UPnP port
/// forwarding + a stable listen port so NAT'd users get inbound peers, and
/// fastresume so restarts pick up where they left off.
async fn ensure_session(
    slot: &SessionSlot,
    default_dir: &str,
    limits: LimitsConfig,
) -> anyhow::Result<Arc<Session>> {
    let mut guard = slot.lock().await;
    if let Some(s) = guard.as_ref() {
        return Ok(s.clone());
    }
    let opts = SessionOptions {
        enable_upnp_port_forwarding: true,
        listen_port_range: Some(TORRENT_PORT_RANGE),
        fastresume: true,
        ratelimits: limits,
        ..Default::default()
    };
    let session = Session::new_with_opts(PathBuf::from(default_dir), opts).await?;
    *guard = Some(session.clone());
    Ok(session)
}

impl TorrentManager {
    pub fn new() -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
            active: Arc::new(Mutex::new(HashMap::new())),
            limits: Arc::new(Mutex::new(LimitsConfig::default())),
            resolved: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Set the session-wide download/upload rate limits (bytes/sec; None = unlimited).
    /// Applies live if a session exists, and is remembered for the next one.
    pub async fn set_rate_limit(&self, download_bps: Option<NonZeroU32>, upload_bps: Option<NonZeroU32>) {
        *self.limits.lock().await = LimitsConfig { upload_bps, download_bps };
        if let Some(session) = self.session.lock().await.as_ref() {
            session.ratelimits.set_download_bps(download_bps);
            session.ratelimits.set_upload_bps(upload_bps);
        }
    }

    /// Resolve a torrent's file list *without* downloading (list-only add). For a
    /// magnet this fetches metadata from peers/DHT first, so it can take a few
    /// seconds — hence the timeout. Used to populate the file-selection modal.
    pub async fn list_files(&self, magnet: String, output_dir: String) -> Result<Vec<TorrentFileEntry>, String> {
        let current_limits = *self.limits.lock().await;
        let session = ensure_session(&self.session, &output_dir, current_limits)
            .await
            .map_err(|e| format!("Failed to start torrent engine: {e}"))?;

        let opts = AddTorrentOptions {
            list_only: true,
            output_folder: Some(output_dir),
            ..Default::default()
        };
        let resp = tokio::time::timeout(
            Duration::from_secs(45),
            session.add_torrent(AddTorrent::from_url(&magnet), Some(opts)),
        )
        .await
        .map_err(|_| "Timed out fetching torrent metadata (no peers?)".to_string())?
        .map_err(|e| format!("Failed to read torrent: {e}"))?;

        match resp {
            AddTorrentResponse::ListOnly(lo) => {
                let entries: Vec<TorrentFileEntry> = lo
                    .info
                    .iter_file_details()
                    .map_err(|e| e.to_string())?
                    .enumerate()
                    .map(|(index, d)| TorrentFileEntry {
                        index,
                        name: d.filename.to_string().unwrap_or_else(|_| format!("file {index}")),
                        size: d.len,
                    })
                    .collect();
                // Cache the parsed .torrent so start_torrent skips a second metadata
                // fetch. Bounded; consumed on use.
                let mut cache = self.resolved.lock().await;
                if cache.len() >= RESOLVED_CACHE_CAP {
                    if let Some(k) = cache.keys().next().cloned() {
                        cache.remove(&k);
                    }
                }
                cache.insert(magnet, lo.torrent_bytes.to_vec());
                Ok(entries)
            }
            _ => Err("Torrent did not return a file list".into()),
        }
    }

    /// Start (or resume) a magnet/`.torrent` download into `output_dir`. Emits
    /// progress until the seed policy is satisfied, then a completion event.
    pub fn start_torrent(
        &self,
        app: AppHandle,
        id: String,
        magnet: String,
        output_dir: String,
        policy: SeedingPolicy,
        only_files: Option<Vec<usize>>,
    ) {
        let session_slot = self.session.clone();
        let active = self.active.clone();
        let limits_slot = self.limits.clone();
        let resolved = self.resolved.clone();

        tauri::async_runtime::spawn(async move {
            let current_limits = *limits_slot.lock().await;
            let session = match ensure_session(&session_slot, &output_dir, current_limits).await {
                Ok(s) => s,
                Err(e) => return emit_failure(&app, &id, format!("Failed to start torrent engine: {e}")),
            };

            // Prefer metadata already resolved by the file picker; fall back to the URL.
            let add = match resolved.lock().await.remove(&magnet) {
                Some(bytes) => AddTorrent::from_bytes(bytes),
                None => AddTorrent::from_url(&magnet),
            };
            let opts = AddTorrentOptions {
                output_folder: Some(output_dir.clone()),
                // None = all files; Some(indices) downloads only the picked ones.
                only_files: only_files.clone(),
                ..Default::default()
            };
            // Distinguish Added from AlreadyManaged: a duplicate would otherwise
            // hand back a shared handle, so cancelling one queue item would delete
            // the torrent out from under the other.
            let handle = match session.add_torrent(add, Some(opts)).await {
                Ok(AddTorrentResponse::Added(_, h)) => h,
                Ok(AddTorrentResponse::AlreadyManaged(_, _)) => {
                    return emit_failure(&app, &id, "This torrent is already in the queue.".into())
                }
                Ok(AddTorrentResponse::ListOnly(_)) => {
                    return emit_failure(&app, &id, "Torrent added in list-only mode".into())
                }
                Err(e) => return emit_failure(&app, &id, format!("Failed to add torrent: {e}")),
            };

            active.lock().await.insert(id.clone(), handle.clone());

            let mut ticks: u64 = 0;
            let mut stall = StallWatch::new(STALL_TIMEOUT_SECS);

            loop {
                // Removal from the map is the cancel signal — exit without emitting
                // completion; the reducer's cancel guard already won that race.
                if !active.lock().await.contains_key(&id) {
                    return;
                }

                let stats = handle.stats();

                // Fail fast on an engine error (disk full, unrecoverable, …).
                if matches!(stats.state, TorrentStatsState::Error) {
                    active.lock().await.remove(&id);
                    let msg = stats.error.unwrap_or_else(|| "Torrent failed".to_string());
                    return emit_failure(&app, &id, msg);
                }

                let (speed, upload_speed, peers) = match &stats.live {
                    Some(l) => (
                        l.download_speed.mbps * BYTES_PER_MIB,
                        l.upload_speed.mbps * BYTES_PER_MIB,
                        l.snapshot.peer_stats.live as u32,
                    ),
                    None => (0.0, 0.0, 0),
                };

                // Stall watchdog: give up if a still-downloading torrent makes no
                // progress for STALL_TIMEOUT_SECS (dead magnet / no seeders).
                if stall.tick(stats.progress_bytes, stats.finished) {
                    active.lock().await.remove(&id);
                    return emit_failure(
                        &app,
                        &id,
                        "Stalled — no data received for 5 minutes (no seeders?)".into(),
                    );
                }

                let progress = if stats.total_bytes > 0 {
                    stats.progress_bytes as f64 / stats.total_bytes as f64 * 100.0
                } else {
                    0.0
                };
                let ratio = if stats.progress_bytes > 0 {
                    stats.uploaded_bytes as f64 / stats.progress_bytes as f64
                } else {
                    0.0
                };
                let eta = if speed > 0.0 {
                    stats.total_bytes.saturating_sub(stats.progress_bytes) as f64 / speed
                } else {
                    0.0
                };

                // The file list is static; only re-send it periodically (and when
                // finished) to avoid re-allocating/serialising it every second.
                let files = if ticks % FILE_LIST_EMIT_EVERY_SECS == 0 || stats.finished {
                    file_breakdown(&handle, &stats.file_progress)
                } else {
                    Vec::new()
                };

                let _ = app.emit(
                    &format!("download-progress-{id}"),
                    TorrentProgress {
                        id: id.clone(),
                        downloaded_bytes: stats.progress_bytes,
                        total_bytes: stats.total_bytes,
                        progress,
                        speed,
                        eta,
                        upload_speed,
                        peers,
                        ratio,
                        seeding: stats.finished,
                        files,
                    },
                );

                if stats.finished && seeding_complete(policy, ratio) {
                    break;
                }

                ticks += 1;
                tokio::time::sleep(Duration::from_secs(1)).await;
            }

            active.lock().await.remove(&id);
            let total = handle.stats().total_bytes;
            // Resolve an openable path: <output_dir>/<torrent name>. For a
            // single-file torrent that's the file (Play works); for a multi-file
            // torrent it's the top-level folder (Show-in-Folder reveals it).
            let file_path = handle
                .name()
                .map(|name| PathBuf::from(&output_dir).join(name).to_string_lossy().into_owned())
                .filter(|p| std::path::Path::new(p).exists());
            let _ = app.emit(
                &format!("download-complete-{id}"),
                DownloadComplete {
                    id: id.clone(),
                    success: true,
                    error: None,
                    file_path,
                    file_size: Some(total),
                },
            );
        });
    }

    /// Stop a torrent and drop it from the session (does not delete files, so a
    /// later re-add resumes from what's on disk). Returns whether it was active.
    pub async fn cancel_torrent(&self, id: &str) -> bool {
        let handle = self.active.lock().await.remove(id);
        match handle {
            Some(h) => {
                if let Some(session) = self.session.lock().await.as_ref() {
                    let _ = session.delete(TorrentIdOrHash::from(h.id()), false).await;
                }
                true
            }
            None => false,
        }
    }
}

impl Default for TorrentManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether seeding is done and the item should complete, per the user's policy.
fn seeding_complete(policy: SeedingPolicy, ratio: f64) -> bool {
    match policy {
        SeedingPolicy::Stop => true,
        SeedingPolicy::Ratio(target) => ratio >= target,
        SeedingPolicy::Forever => false,
    }
}

/// Detects a stalled download: `tick` is called once per second with the current
/// downloaded byte count; it returns true once a *still-downloading* torrent has
/// made zero progress for `timeout_secs` consecutive ticks. A `finished` torrent
/// (seeding) never stalls.
struct StallWatch {
    last: u64,
    idle: u64,
    timeout: u64,
}

impl StallWatch {
    fn new(timeout_secs: u64) -> Self {
        Self { last: 0, idle: 0, timeout: timeout_secs }
    }

    fn tick(&mut self, progress_bytes: u64, finished: bool) -> bool {
        if finished {
            self.idle = 0;
            return false;
        }
        if progress_bytes > self.last {
            self.last = progress_bytes;
            self.idle = 0;
        } else {
            self.idle += 1;
        }
        self.idle >= self.timeout
    }
}

/// Per-file breakdown for a torrent (empty until metadata resolves).
/// `file_progress` is parallel to the metadata's `file_infos`.
fn file_breakdown(handle: &ManagedTorrentHandle, file_progress: &[u64]) -> Vec<TorrentFile> {
    handle
        .with_metadata(|m| {
            m.file_infos
                .iter()
                .enumerate()
                .map(|(i, fi)| {
                    let done = file_progress.get(i).copied().unwrap_or(0);
                    TorrentFile {
                        name: fi.relative_filename.to_string_lossy().into_owned(),
                        size: fi.len,
                        progress: if fi.len > 0 {
                            done as f64 / fi.len as f64 * 100.0
                        } else {
                            100.0
                        },
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn emit_failure(app: &AppHandle, id: &str, message: String) {
    let _ = app.emit(
        &format!("download-complete-{id}"),
        DownloadComplete {
            id: id.to_string(),
            success: false,
            error: Some(message),
            file_path: None,
            file_size: None,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeding_policy_decisions() {
        assert!(seeding_complete(SeedingPolicy::Stop, 0.0));
        assert!(!seeding_complete(SeedingPolicy::Forever, 999.0));
        assert!(!seeding_complete(SeedingPolicy::Ratio(1.0), 0.99));
        assert!(seeding_complete(SeedingPolicy::Ratio(1.0), 1.0));
        assert!(seeding_complete(SeedingPolicy::Ratio(1.0), 2.5));
    }

    #[test]
    fn stall_fires_only_after_timeout_of_no_progress() {
        let mut w = StallWatch::new(3);
        // Progress each tick → never stalls.
        assert!(!w.tick(10, false));
        assert!(!w.tick(20, false));
        assert!(!w.tick(30, false));
        // Now frozen: needs 3 consecutive idle ticks.
        assert!(!w.tick(30, false)); // idle 1
        assert!(!w.tick(30, false)); // idle 2
        assert!(w.tick(30, false)); // idle 3 → stalled
    }

    #[test]
    fn stall_resets_on_progress_and_ignores_finished() {
        let mut w = StallWatch::new(2);
        assert!(!w.tick(0, false)); // idle 1
        assert!(!w.tick(100, false)); // progress → reset
        assert!(!w.tick(100, false)); // idle 1
        // A finished (seeding) torrent never stalls, even sitting at the same bytes.
        assert!(!w.tick(100, true));
        assert!(!w.tick(100, true));
        assert!(!w.tick(100, true));
        // Back to downloading with no progress: two idle ticks → stalls.
        assert!(!w.tick(100, false)); // idle 1
        assert!(w.tick(100, false)); // idle 2 → stalled
    }
}
