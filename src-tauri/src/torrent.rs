//! BitTorrent engine spike (go/no-go). Wraps librqbit to download a magnet/torrent
//! URL to disk while reporting progress. Deliberately UI-less: this exists to prove
//! the library integrates against our toolchain and Tauri dep tree, and that a real
//! magnet resolves via DHT and completes, before we commit to the second-engine arc.
//! See ROADMAP.md → "Second engine: BitTorrent".

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use librqbit::api::TorrentIdOrHash;
use librqbit::{AddTorrent, AddTorrentOptions, ManagedTorrent, Session};

/// librqbit's handle type (not re-exported at the crate root in 8.x).
type ManagedTorrentHandle = Arc<ManagedTorrent>;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::download_manager::DownloadComplete;

const BYTES_PER_MIB: f64 = 1024.0 * 1024.0;

/// Download a magnet or `.torrent` URL into `output_dir`, calling `on_progress`
/// with (downloaded_bytes, total_bytes) roughly once a second until complete.
/// Returns the output directory on success.
pub async fn download_magnet<F: Fn(u64, u64)>(
    magnet: &str,
    output_dir: PathBuf,
    on_progress: F,
) -> anyhow::Result<PathBuf> {
    let session = Session::new(output_dir.clone()).await?;
    let handle = session
        .add_torrent(AddTorrent::from_url(magnet), None)
        .await?
        .into_handle()
        .ok_or_else(|| anyhow::anyhow!("torrent was added in list-only mode"))?;

    loop {
        let stats = handle.stats();
        on_progress(stats.progress_bytes, stats.total_bytes);
        if stats.finished {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    Ok(output_dir)
}

// ── Production engine: TorrentManager ────────────────────────────────────
//
// Mirrors download_manager::DownloadManager but backed by librqbit. It emits the
// same `download-progress-{id}` / `download-complete-{id}` events the frontend
// already listens to, so torrents flow through the existing queue. The progress
// payload carries extra swarm stats (upload speed, peers, ratio) and a `seeding`
// flag that drives the queue's downloading→seeding transition.

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
    pub seeds: u32,
    pub ratio: f64,
    pub seeding: bool,
}

type SessionSlot = Arc<Mutex<Option<Arc<Session>>>>;

pub struct TorrentManager {
    /// One librqbit session for the whole app, created lazily on first torrent.
    session: SessionSlot,
    /// Active torrents by queue id. Removal is the cancel signal for the poll loop.
    active: Arc<Mutex<HashMap<String, ManagedTorrentHandle>>>,
}

/// Lazily create and cache the shared librqbit session.
async fn ensure_session(slot: &SessionSlot, default_dir: &str) -> anyhow::Result<Arc<Session>> {
    let mut guard = slot.lock().await;
    if let Some(s) = guard.as_ref() {
        return Ok(s.clone());
    }
    let session = Session::new(PathBuf::from(default_dir)).await?;
    *guard = Some(session.clone());
    Ok(session)
}

impl TorrentManager {
    pub fn new() -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
            active: Arc::new(Mutex::new(HashMap::new())),
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
    ) {
        let session_slot = self.session.clone();
        let active = self.active.clone();

        tauri::async_runtime::spawn(async move {
            let session = match ensure_session(&session_slot, &output_dir).await {
                Ok(s) => s,
                Err(e) => return emit_failure(&app, &id, format!("Failed to start torrent engine: {e}")),
            };

            let opts = AddTorrentOptions {
                output_folder: Some(output_dir.clone()),
                ..Default::default()
            };
            let handle = match session.add_torrent(AddTorrent::from_url(&magnet), Some(opts)).await {
                Ok(resp) => match resp.into_handle() {
                    Some(h) => h,
                    None => return emit_failure(&app, &id, "Torrent added in list-only mode".into()),
                },
                Err(e) => return emit_failure(&app, &id, format!("Failed to add torrent: {e}")),
            };

            active.lock().await.insert(id.clone(), handle.clone());

            loop {
                // Removal from the map is the cancel signal — exit without emitting
                // completion; the reducer's cancel guard already won that race.
                if !active.lock().await.contains_key(&id) {
                    return;
                }

                let stats = handle.stats();
                let (speed, upload_speed, peers, seeds) = match &stats.live {
                    Some(l) => (
                        l.download_speed.mbps * BYTES_PER_MIB,
                        l.upload_speed.mbps * BYTES_PER_MIB,
                        l.snapshot.peer_stats.live as u32,
                        // librqbit's aggregate stats don't split seeds from peers;
                        // "seen" is the closest available count of known peers.
                        l.snapshot.peer_stats.seen as u32,
                    ),
                    None => (0.0, 0.0, 0, 0),
                };
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
                        seeds,
                        ratio,
                        seeding: stats.finished,
                    },
                );

                if stats.finished {
                    let done = match policy {
                        SeedingPolicy::Stop => true,
                        SeedingPolicy::Ratio(target) => ratio >= target,
                        SeedingPolicy::Forever => false,
                    };
                    if done {
                        break;
                    }
                }

                tokio::time::sleep(Duration::from_secs(1)).await;
            }

            active.lock().await.remove(&id);
            let total = handle.stats().total_bytes;
            // file_path is left None for now: torrents can be multi-file/dir, so we
            // don't yet resolve a single openable path for Play/Show-in-Folder.
            let _ = app.emit(
                &format!("download-complete-{id}"),
                DownloadComplete {
                    id: id.clone(),
                    success: true,
                    error: None,
                    file_path: None,
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
