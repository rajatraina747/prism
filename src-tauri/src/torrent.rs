//! BitTorrent engine. Wraps librqbit behind a `TorrentManager` that mirrors
//! `download_manager::DownloadManager`: it emits the same `download-progress-{id}` /
//! `download-complete-{id}` events so torrents flow through the existing queue, plus
//! torrent-only swarm stats and a `seeding` flag. See ROADMAP.md → "Second engine".
//!
//! Trust boundary: file names inside a torrent come from untrusted metadata. Writes
//! are confined to `output_folder` and librqbit is responsible for rejecting
//! path-traversal (`../`) entries — we never join those names ourselves except for
//! the top-level torrent name (also librqbit-provided) when resolving an open path.
//!
//! What librqbit 9 does and doesn't give us shapes this module: pause/unpause
//! keeps piece state and re-announces (our "update tracker"); per-peer counters
//! exist but per-peer speeds are differenced here; the have-pieces bitfield is
//! only reachable through `librqbit::api::Api`; there is no per-tracker status,
//! no live tracker add, no sequential mode, no per-torrent limits after add.

use std::collections::HashMap;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use librqbit::api::{Api, TorrentIdOrHash};
use librqbit::limits::LimitsConfig;
use librqbit::{
    torrent_from_bytes, AddTorrent, AddTorrentOptions, AddTorrentResponse, ConnectionOptions,
    ListenerMode, ListenerOptions, Magnet, ManagedTorrent, Session, SessionOptions,
    SessionPersistenceConfig, TorrentStatsState,
};

use crate::download_manager::DownloadComplete;

/// Default listen port; overridable via the `torrentListenPort` setting.
pub const DEFAULT_LISTEN_PORT: u16 = 4240;

/// What the engine is allowed to receive as a torrent source. Built by
/// `lib::resolve_torrent_source`, which is the only place raw webview input is
/// turned into one of these — a bare string is never handed to librqbit.
#[derive(Clone)]
pub enum TorrentSource {
    /// A `magnet:` link or an http(s) URL of a `.torrent` file.
    Url(String),
    /// `.torrent` bytes already validated by the caller (OS file association,
    /// or the on-disk metadata cache for a magnet we resolved before). `key`
    /// identifies it (the original magnet/path); `trackers` carries a magnet's
    /// `tr=` announce URLs, which the cached bytes alone don't preserve.
    Bytes {
        key: String,
        bytes: Vec<u8>,
        trackers: Vec<String>,
    },
}

impl TorrentSource {
    fn key(&self) -> &str {
        match self {
            TorrentSource::Url(u) => u,
            TorrentSource::Bytes { key, .. } => key,
        }
    }

    fn trackers(&self) -> Vec<String> {
        match self {
            TorrentSource::Url(_) => Vec::new(),
            TorrentSource::Bytes { trackers, .. } => trackers.clone(),
        }
    }

    fn into_add(self) -> AddTorrent<'static> {
        match self {
            TorrentSource::Url(u) => AddTorrent::Url(std::borrow::Cow::Owned(u)),
            TorrentSource::Bytes { bytes, .. } => AddTorrent::from_bytes(bytes),
        }
    }
}

/// Session-wide engine settings, read from settings.json at engine start
/// (see `lib::torrent_session_config`). The session is created once per app
/// run, so most of these apply on the next launch.
#[derive(Clone, Default)]
pub struct SessionConfig {
    /// socks5(h):// proxy for outgoing peer connections. librqbit proxies
    /// peers only — DHT, trackers and the .torrent/blocklist fetches go
    /// direct — which the Settings copy states explicitly.
    pub socks_proxy: Option<String>,
    pub blocklist_url: Option<String>,
    /// Open a router port via UPnP for inbound peers.
    pub upnp: bool,
    /// Join the DHT (off = tracker-only).
    pub dht: bool,
    /// Also accept/make uTP connections (librqbit default is TCP only).
    pub utp: bool,
    /// Local Service Discovery (find peers on the LAN).
    pub lsd: bool,
    pub listen_port: u16,
    /// Max connected peers per torrent (None = engine default).
    pub peer_limit: Option<usize>,
    /// Extra announce URLs applied to every torrent.
    pub trackers: Vec<String>,
    /// Where librqbit persists session state + have-pieces bitfields so a
    /// restart resumes without a full re-hash. None = no persistence.
    pub persistence_dir: Option<PathBuf>,
    /// Where resolved `.torrent` metadata is cached (`<infohash>.torrent`) so a
    /// retry of a magnet knows its size and files without any peers.
    pub torrent_cache_dir: Option<PathBuf>,
    /// Fail a torrent that has been peerless this long (None = never — the
    /// uTorrent/Vuze behaviour; it just keeps announcing).
    pub give_up_after: Option<Duration>,
    /// Stop seeding after this long regardless of ratio (None = no limit).
    pub seed_time_limit: Option<Duration>,
}

const BYTES_PER_MIB: f64 = 1024.0 * 1024.0;

/// While a torrent has had no connected peers for this many consecutive
/// seconds, nudge trackers + DHT + LSD again (pause/unpause keeps piece
/// state and issues a fresh `started` announce). uTorrent re-announces on
/// roughly this cadence when starved, too.
pub(crate) const REANNOUNCE_EVERY_SECS: u64 = 300;

/// Re-send the (static) file list at most this often — per-file progress refreshes
/// on this cadence while the cheap top-line stats update every second. The
/// pieces bitmap rides along on the same cadence.
const FILE_LIST_EMIT_EVERY_SECS: u64 = 5;

/// Buckets in the downsampled pieces bar sent to the UI.
pub(crate) const PIECE_BUCKETS: usize = 200;

/// librqbit's handle type (not re-exported at the crate root).
type ManagedTorrentHandle = Arc<ManagedTorrent>;

// ── Public payloads ─────────────────────────────────────────────────────

/// What to do once a torrent finishes downloading. Sourced from the user's
/// `seedingPolicy` + `seedRatioTarget` settings (see lib::seeding_policy).
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
    /// Swarm-health detail: peers discovered (connected or not) and mid-
    /// handshake. 0 connected / 0 seen = dead swarm; 0 connected / many seen
    /// = connectivity problem. Distinguishing those is the point.
    pub peers_seen: u32,
    pub peers_connecting: u32,
    pub ratio: f64,
    /// Lifetime bytes uploaded for this item (librqbit's own counter resets on
    /// every pause; this one doesn't).
    pub uploaded_bytes: u64,
    /// Consecutive seconds with zero connected peers (0 while connected).
    pub peerless_secs: u64,
    pub seeding: bool,
    /// The torrent's files with per-file progress. Omitted (not just empty) on
    /// ticks where we don't re-send the list, so the frontend keeps the last one.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<TorrentFile>,
    /// Have-pieces bitmap downsampled to `PIECE_BUCKETS` buckets (0–255 =
    /// fraction of that bucket's pieces we have). Same cadence as `files`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub pieces: Vec<u8>,
}

/// One connected (or recently seen) peer, for the Peers tab.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRow {
    pub addr: String,
    pub client: Option<String>,
    /// tcp | utp | socks | unknown
    pub kind: String,
    /// queued | connecting | live | dead | not needed
    pub state: String,
    pub down_bps: f64,
    pub up_bps: f64,
    pub downloaded: u64,
    pub uploaded: u64,
    pub errors: u32,
}

/// Static facts about a torrent, for the General/Trackers tabs.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentDetails {
    pub info_hash: String,
    pub name: Option<String>,
    pub output_folder: String,
    pub total_bytes: u64,
    pub total_pieces: u32,
    pub piece_length: u32,
    pub private: bool,
    pub trackers: Vec<String>,
    pub file_count: usize,
    pub added_at: String,
    pub state: String,
}

/// Session-wide numbers for the transfers footer.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub download_bps: f64,
    pub upload_bps: f64,
    pub peers_live: u32,
    pub peers_connecting: u32,
    pub peers_seen: u32,
    pub dht_nodes: usize,
    pub listen_port: Option<u16>,
    pub upnp: bool,
    pub dht: bool,
    pub utp: bool,
    pub active_torrents: usize,
}

// ── Manager state ───────────────────────────────────────────────────────

struct ActiveTorrent {
    handle: ManagedTorrentHandle,
    output_dir: String,
    /// Uploaded bytes from earlier live phases of this item (folded in on
    /// every pause/reannounce/recheck, since librqbit's counter restarts).
    uploaded_offset: u64,
    /// Previous per-peer counters, for speed differencing in `peers()`.
    peer_prev: HashMap<String, (u64, u64, Instant)>,
    /// One-shot requests serviced by the poll loop on its next tick.
    reannounce_requested: bool,
    recheck_requested: bool,
    added_at: String,
}

type SessionSlot = Arc<Mutex<Option<(Arc<Session>, Arc<Api>)>>>;

/// Cap on cached parsed-torrent metadata so parsing many torrents without
/// downloading them can't grow memory without bound.
const RESOLVED_CACHE_CAP: usize = 16;

pub struct TorrentManager {
    /// One librqbit session (+ its `Api`, the only way to the pieces
    /// bitfield) for the whole app, created lazily on first torrent.
    session: SessionSlot,
    /// Active torrents by queue id. Removal is the cancel signal for the poll
    /// loop.
    active: Arc<Mutex<HashMap<String, ActiveTorrent>>>,
    /// Session-wide rate limits (download, upload). Applied at session creation
    /// and updated live — user limits merged with Quiet Hours by the frontend.
    limits: Arc<Mutex<LimitsConfig>>,
    /// `.torrent` bytes resolved by `list_files` or a completed add, keyed by
    /// source, so `start_torrent` can add from bytes instead of re-fetching
    /// magnet metadata from peers.
    resolved: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    /// Config the session was (or will be) created with — for the stats event.
    cfg: Arc<Mutex<SessionConfig>>,
}

/// Lazily create and cache the shared librqbit session, and start the
/// session-stats emitter alongside it.
async fn ensure_session(
    app: &AppHandle,
    slot: &SessionSlot,
    active: &Arc<Mutex<HashMap<String, ActiveTorrent>>>,
    default_dir: &str,
    limits: LimitsConfig,
    cfg: SessionConfig,
) -> anyhow::Result<Arc<Session>> {
    let mut guard = slot.lock().await;
    if let Some((s, _)) = guard.as_ref() {
        return Ok(s.clone());
    }
    let defaults = SessionOptions::default();
    let opts = SessionOptions {
        listen: Some(ListenerOptions {
            listen_addr: (std::net::Ipv6Addr::UNSPECIFIED, cfg.listen_port).into(),
            enable_upnp_port_forwarding: cfg.upnp,
            mode: if cfg.utp { ListenerMode::TcpAndUtp } else { ListenerMode::TcpOnly },
            ..Default::default()
        }),
        connect: Some(ConnectionOptions {
            // librqbit only supports socks5; http proxies are ignored for torrents.
            proxy_url: cfg
                .socks_proxy
                .clone()
                .filter(|p| p.to_ascii_lowercase().starts_with("socks5")),
            ..Default::default()
        }),
        // Keep librqbit's default DHT config (with persistence) when enabled.
        dht: if cfg.dht { defaults.dht } else { None },
        disable_local_service_discovery: !cfg.lsd,
        peer_limit: cfg.peer_limit,
        // Session state + have-pieces bitfields on disk: a relaunch spot-checks
        // a few pieces instead of re-hashing gigabytes.
        persistence: cfg
            .persistence_dir
            .clone()
            .map(|folder| SessionPersistenceConfig::Json { folder: Some(folder) }),
        fastresume: cfg.persistence_dir.is_some(),
        ratelimits: limits,
        // Standard p2p-format IP blocklist, fetched once per session.
        blocklist_url: cfg.blocklist_url.clone(),
        // Already scheme-checked and bounded in lib::parse_extra_trackers.
        trackers: cfg
            .trackers
            .iter()
            .filter_map(|t| url::Url::parse(t).ok())
            .collect(),
        ..defaults
    };
    let session = Session::new_with_opts(PathBuf::from(default_dir), opts).await?;
    let api = Arc::new(Api::new(session.clone(), None));
    *guard = Some((session.clone(), api));
    spawn_session_stats(app.clone(), session.clone(), active.clone(), cfg);
    Ok(session)
}

/// Emit `torrent-session-stats` once a second while torrents are active
/// (every 5 s otherwise) for the transfers footer.
fn spawn_session_stats(
    app: AppHandle,
    session: Arc<Session>,
    active: Arc<Mutex<HashMap<String, ActiveTorrent>>>,
    cfg: SessionConfig,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            let active_count = active.lock().await.len();
            let snap = session.stats_snapshot();
            let dht_nodes = session
                .get_dht()
                .map(|d| {
                    let s = d.stats();
                    s.routing_table_size + s.routing_table_size_v6
                })
                .unwrap_or(0);
            let _ = app.emit(
                "torrent-session-stats",
                SessionStats {
                    download_bps: snap.download_speed.mbps * BYTES_PER_MIB,
                    upload_bps: snap.upload_speed.mbps * BYTES_PER_MIB,
                    peers_live: snap.peers.live,
                    peers_connecting: snap.peers.connecting,
                    peers_seen: snap.peers.seen,
                    dht_nodes,
                    listen_port: session.listen_addr().map(|a| a.port()),
                    upnp: cfg.upnp,
                    dht: cfg.dht,
                    utp: cfg.utp,
                    active_torrents: active_count,
                },
            );
            tokio::time::sleep(Duration::from_secs(if active_count > 0 { 1 } else { 5 })).await;
        }
    });
}

impl TorrentManager {
    pub fn new() -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
            active: Arc::new(Mutex::new(HashMap::new())),
            limits: Arc::new(Mutex::new(LimitsConfig::default())),
            resolved: Arc::new(Mutex::new(HashMap::new())),
            cfg: Arc::new(Mutex::new(SessionConfig::default())),
        }
    }

    async fn session(&self) -> Option<Arc<Session>> {
        self.session.lock().await.as_ref().map(|(s, _)| s.clone())
    }

    /// Set the session-wide download/upload rate limits (bytes/sec; None = unlimited).
    /// Applies live if a session exists, and is remembered for the next one.
    pub async fn set_rate_limit(&self, download_bps: Option<NonZeroU32>, upload_bps: Option<NonZeroU32>) {
        *self.limits.lock().await = LimitsConfig { upload_bps, download_bps };
        if let Some(session) = self.session().await {
            session.ratelimits.set_download_bps(download_bps);
            session.ratelimits.set_upload_bps(upload_bps);
        }
    }

    async fn remember_resolved(&self, key: String, bytes: Vec<u8>) {
        let mut cache = self.resolved.lock().await;
        if cache.len() >= RESOLVED_CACHE_CAP && !cache.contains_key(&key) {
            if let Some(k) = cache.keys().next().cloned() {
                cache.remove(&k);
            }
        }
        cache.insert(key, bytes);
    }

    /// Resolve a torrent's file list *without* downloading (list-only add). For a
    /// magnet this fetches metadata from peers/DHT first, so it can take a few
    /// seconds — hence the timeout. Used to populate the file-selection modal.
    pub async fn list_files(
        &self,
        app: &AppHandle,
        source: TorrentSource,
        output_dir: String,
        cfg: SessionConfig,
    ) -> Result<Vec<TorrentFileEntry>, String> {
        *self.cfg.lock().await = cfg.clone();
        let current_limits = *self.limits.lock().await;
        let session = ensure_session(app, &self.session, &self.active, &output_dir, current_limits, cfg.clone())
            .await
            .map_err(|e| format!("Failed to start torrent engine: {e}"))?;

        let key = source.key().to_string();
        let opts = AddTorrentOptions {
            list_only: true,
            output_folder: Some(output_dir),
            trackers: Some(source.trackers()).filter(|t| !t.is_empty()),
            ..Default::default()
        };
        let resp = tokio::time::timeout(
            Duration::from_secs(45),
            session.add_torrent(source.into_add(), Some(opts)),
        )
        .await
        .map_err(|_| "Timed out fetching torrent metadata (no peers?)".to_string())?
        .map_err(|e| format!("Failed to read torrent: {e}"))?;

        match resp {
            AddTorrentResponse::ListOnly(lo) => {
                let entries: Vec<TorrentFileEntry> = lo
                    .info
                    .iter_file_details()
                    .enumerate()
                    .map(|(index, d)| TorrentFileEntry {
                        index,
                        name: d.filename.to_string(),
                        size: d.len,
                    })
                    .collect();
                // Cache the parsed .torrent (memory + disk) so start_torrent and
                // any later retry skip the metadata fetch.
                cache_torrent_bytes(cfg.torrent_cache_dir.as_deref(), &lo.info_hash.as_string(), &lo.torrent_bytes);
                self.remember_resolved(key, lo.torrent_bytes.to_vec()).await;
                Ok(entries)
            }
            _ => Err("Torrent did not return a file list".into()),
        }
    }

    /// Start (or resume) a magnet/`.torrent` download into `output_dir`. Emits
    /// progress until the seed policy is satisfied, then a completion event.
    /// Proxy, blocklist, UPnP, DHT etc. come from `cfg` (session-wide);
    /// `download_limit` (bytes/sec) caps this torrent alone.
    #[allow(clippy::too_many_arguments)]
    pub fn start_torrent(
        &self,
        app: AppHandle,
        id: String,
        source: TorrentSource,
        output_dir: String,
        policy: SeedingPolicy,
        only_files: Option<Vec<usize>>,
        cfg: SessionConfig,
        download_limit: Option<u64>,
    ) {
        let session_slot = self.session.clone();
        let active = self.active.clone();
        let limits_slot = self.limits.clone();
        let resolved = self.resolved.clone();
        let cfg_slot = self.cfg.clone();

        tauri::async_runtime::spawn(async move {
            *cfg_slot.lock().await = cfg.clone();
            let current_limits = *limits_slot.lock().await;
            let session = match ensure_session(&app, &session_slot, &active, &output_dir, current_limits, cfg.clone()).await {
                Ok(s) => s,
                Err(e) => return emit_failure(&app, &id, format!("Failed to start torrent engine: {e}")),
            };
            let api = session_slot.lock().await.as_ref().map(|(_, a)| a.clone());

            let add_params = AddParams {
                source: source.clone(),
                output_dir: output_dir.clone(),
                only_files: only_files.clone(),
                download_limit,
                peer_limit: cfg.peer_limit,
                cache_dir: cfg.torrent_cache_dir.clone(),
                fallback_name: fallback_folder_name(&source),
            };

            // `output_dir` from here on is the folder the files actually go
            // in (a subfolder of the destination for multi-file torrents).
            let (handle, output_dir) = match add_or_adopt(&session, &active, &resolved, &add_params).await {
                Ok(pair) => pair,
                Err(e) => return emit_failure(&app, &id, e),
            };

            active.lock().await.insert(
                id.clone(),
                ActiveTorrent {
                    handle: handle.clone(),
                    output_dir: output_dir.clone(),
                    uploaded_offset: 0,
                    peer_prev: HashMap::new(),
                    reannounce_requested: false,
                    recheck_requested: false,
                    added_at: chrono::Utc::now().to_rfc3339(),
                },
            );

            let mut handle = handle;
            let mut ticks: u64 = 0;
            let mut peerless = PeerlessWatch::new();
            let mut seed_started: Option<Instant> = None;
            let mut cached_bytes = false;

            loop {
                // Removal from the map is the cancel signal — exit without emitting
                // completion; the reducer's cancel guard already won that race.
                let (reannounce, recheck, uploaded_offset) = {
                    let mut map = active.lock().await;
                    let Some(entry) = map.get_mut(&id) else { return };
                    let flags = (entry.reannounce_requested, entry.recheck_requested, entry.uploaded_offset);
                    entry.reannounce_requested = false;
                    entry.recheck_requested = false;
                    flags
                };

                // One-shot requests from the UI, serviced inside a single tick so
                // the paused branch below never sees the internal pause.
                if recheck {
                    fold_uploaded(&active, &id, &handle).await;
                    let _ = session.delete(TorrentIdOrHash::from(handle.id()), false).await;
                    match add_or_adopt(&session, &active, &resolved, &add_params).await {
                        Ok((h, dir)) => {
                            handle = h;
                            if let Some(entry) = active.lock().await.get_mut(&id) {
                                entry.handle = handle.clone();
                                entry.output_dir = dir;
                                entry.peer_prev.clear();
                            }
                        }
                        Err(e) => {
                            active.lock().await.remove(&id);
                            return emit_failure(&app, &id, format!("Re-check failed: {e}"));
                        }
                    }
                } else if reannounce {
                    reannounce_now(&session, &active, &id, &handle).await;
                    peerless.on_reannounce();
                }

                // Cache the .torrent bytes once metadata is known (magnets resolve
                // it from peers) so a retry never needs the swarm to learn its size.
                if !cached_bytes {
                    if let Ok((hash, bytes)) = handle.with_metadata(|m| (handle.info_hash().as_string(), m.torrent_bytes.to_vec())) {
                        cache_torrent_bytes(cfg.torrent_cache_dir.as_deref(), &hash, &bytes);
                        {
                            let mut cache = resolved.lock().await;
                            cache.insert(source.key().to_string(), bytes);
                        }
                        cached_bytes = true;
                    }
                }

                let stats = handle.stats();

                // Fail fast on an engine error (disk full, unrecoverable, …).
                if matches!(stats.state, TorrentStatsState::Error) {
                    active.lock().await.remove(&id);
                    let msg = stats.error.unwrap_or_else(|| "Torrent failed".to_string());
                    return emit_failure(&app, &id, msg);
                }

                // A paused torrent stays in the loop (cancel and resume still
                // work through the live handle) but emits nothing — the
                // frontend already renders it as paused.
                if handle.is_paused() {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }

                let (speed, upload_speed, peers, peers_seen, peers_connecting) = match &stats.live {
                    Some(l) => (
                        l.download_speed.mbps * BYTES_PER_MIB,
                        l.upload_speed.mbps * BYTES_PER_MIB,
                        l.snapshot.peer_stats.live,
                        l.snapshot.peer_stats.seen,
                        l.snapshot.peer_stats.connecting,
                    ),
                    None => (0.0, 0.0, 0, 0, 0),
                };

                // Peerless bookkeeping: never fail on its own (a dead-looking
                // swarm routinely comes back); re-announce every few minutes and
                // only give up if the user asked for a limit.
                let starved = matches!(stats.state, TorrentStatsState::Live)
                    && !stats.finished
                    && peers == 0;
                let peerless_secs = peerless.tick(stats.progress_bytes, starved);
                if let Some(limit) = cfg.give_up_after {
                    if peerless_secs >= limit.as_secs() {
                        active.lock().await.remove(&id);
                        return emit_failure(
                            &app,
                            &id,
                            format!(
                                "No peers found for {} — stopped by the \"give up\" limit in Settings",
                                human_minutes(limit)
                            ),
                        );
                    }
                }
                if peerless.reannounce_due() {
                    reannounce_now(&session, &active, &id, &handle).await;
                    peerless.on_reannounce();
                    log::info!("torrent {id}: peerless for {peerless_secs}s, re-announced");
                }

                let uploaded = uploaded_offset + stats.uploaded_bytes;
                let progress = if stats.total_bytes > 0 {
                    stats.progress_bytes as f64 / stats.total_bytes as f64 * 100.0
                } else {
                    0.0
                };
                let ratio = if stats.progress_bytes > 0 {
                    uploaded as f64 / stats.progress_bytes as f64
                } else {
                    0.0
                };
                let eta = if speed > 0.0 {
                    stats.total_bytes.saturating_sub(stats.progress_bytes) as f64 / speed
                } else {
                    0.0
                };

                // The file list and pieces bitmap are re-sent periodically (and
                // when finished) rather than every second.
                let periodic = ticks % FILE_LIST_EMIT_EVERY_SECS == 0 || stats.finished;
                let files = if periodic {
                    file_breakdown(&handle, &stats.file_progress)
                } else {
                    Vec::new()
                };
                let pieces = if periodic {
                    api.as_ref()
                        .and_then(|a| a.api_dump_haves(TorrentIdOrHash::from(handle.id())).ok())
                        .map(|(bf, total)| downsample_pieces(&(0..total as usize).map(|i| bf[i]).collect::<Vec<bool>>(), PIECE_BUCKETS))
                        .unwrap_or_default()
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
                        peers_seen,
                        peers_connecting,
                        ratio,
                        uploaded_bytes: uploaded,
                        peerless_secs,
                        seeding: stats.finished,
                        files,
                        pieces,
                    },
                );

                if stats.finished {
                    let started = *seed_started.get_or_insert_with(Instant::now);
                    if seeding_complete(policy, ratio, cfg.seed_time_limit, started.elapsed()) {
                        break;
                    }
                }

                ticks += 1;
                tokio::time::sleep(Duration::from_secs(1)).await;
            }

            active.lock().await.remove(&id);
            let total = handle.stats().total_bytes;
            let file_path = resolve_completion_path(&handle, &output_dir);
            mark_torrent_files_downloaded(&handle, &output_dir);
            log::info!("torrent {id}: completed ({total} bytes)");
            let _ = app.emit(
                &format!("download-complete-{id}"),
                DownloadComplete {
                    id: id.clone(),
                    success: true,
                    error: None,
                    file_path,
                    file_size: Some(total),
                    actual_height: None,
                    output_folder: Some(output_dir),
                },
            );
        });
    }

    async fn handle_of(&self, id: &str) -> Result<ManagedTorrentHandle, String> {
        self.active
            .lock()
            .await
            .get(id)
            .map(|e| e.handle.clone())
            .ok_or_else(|| "Torrent is not active".to_string())
    }

    /// Pause an active torrent in place. The handle stays in the session and
    /// the poll loop keeps running, so resuming needs no re-add and no hash
    /// re-check of what's already on disk (unlike cancel + re-add).
    pub async fn pause_torrent(&self, id: &str) -> Result<(), String> {
        let handle = self.handle_of(id).await?;
        let session = self.session().await.ok_or("Torrent engine is not running")?;
        fold_uploaded(&self.active, id, &handle).await;
        session.pause(&handle).await.map_err(|e| e.to_string())
    }

    /// Resume a torrent paused with `pause_torrent`.
    pub async fn resume_torrent(&self, id: &str) -> Result<(), String> {
        let handle = self.handle_of(id).await?;
        let session = self.session().await.ok_or("Torrent engine is not running")?;
        session.unpause(&handle).await.map_err(|e| e.to_string())
    }

    /// "Update tracker": ask the poll loop to re-announce on its next tick.
    pub async fn reannounce_torrent(&self, id: &str) -> Result<(), String> {
        let mut map = self.active.lock().await;
        let entry = map.get_mut(id).ok_or("Torrent is not active")?;
        entry.reannounce_requested = true;
        Ok(())
    }

    /// "Force re-check": drop the persisted bitfield and re-add so every piece
    /// is hashed again. Serviced by the poll loop.
    pub async fn recheck_torrent(&self, id: &str) -> Result<(), String> {
        let mut map = self.active.lock().await;
        let entry = map.get_mut(id).ok_or("Torrent is not active")?;
        entry.recheck_requested = true;
        Ok(())
    }

    /// Change which files of an active torrent are downloaded (the queue's
    /// file list is editable mid-download, like uTorrent's per-file skip).
    pub async fn update_file_selection(&self, id: &str, only_files: Vec<usize>) -> Result<(), String> {
        if only_files.is_empty() {
            return Err("At least one file must stay selected".into());
        }
        let handle = self.handle_of(id).await?;
        let session = self.session().await.ok_or("Torrent engine is not running")?;
        let set: std::collections::HashSet<usize> = only_files.into_iter().collect();
        session.update_only_files(&handle, &set).await.map_err(|e| e.to_string())
    }

    /// Connected/seen peers with speeds differenced since the previous call.
    pub async fn peers(&self, id: &str) -> Result<Vec<PeerRow>, String> {
        let mut map = self.active.lock().await;
        let entry = map.get_mut(id).ok_or("Torrent is not active")?;
        let live = entry.handle.live().ok_or("Torrent is not live")?;
        let filter = serde_json::from_value(serde_json::json!({ "state": "all" }))
            .map_err(|e| e.to_string())?;
        let snap = live.per_peer_stats_snapshot(filter);
        let now = Instant::now();
        let mut rows: Vec<PeerRow> = snap
            .peers
            .into_iter()
            .map(|(addr, ps)| {
                let fetched = ps.counters.fetched_bytes;
                let uploaded = ps.counters.uploaded_bytes;
                let (down_bps, up_bps) = match entry.peer_prev.get(&addr) {
                    Some((pf, pu, t)) => {
                        let dt = now.duration_since(*t).as_secs_f64().max(0.001);
                        (
                            fetched.saturating_sub(*pf) as f64 / dt,
                            uploaded.saturating_sub(*pu) as f64 / dt,
                        )
                    }
                    None => (0.0, 0.0),
                };
                entry.peer_prev.insert(addr.clone(), (fetched, uploaded, now));
                PeerRow {
                    addr,
                    client: ps.client_name.clone(),
                    kind: ps
                        .conn_kind
                        .map(|k| k.to_string().to_ascii_lowercase())
                        .unwrap_or_else(|| "unknown".into()),
                    state: ps.state.to_string(),
                    down_bps,
                    up_bps,
                    downloaded: fetched,
                    uploaded,
                    errors: ps.counters.errors,
                }
            })
            .collect();
        // Live first, then by download rate.
        rows.sort_by(|a, b| {
            (b.state == "live")
                .cmp(&(a.state == "live"))
                .then(b.down_bps.partial_cmp(&a.down_bps).unwrap_or(std::cmp::Ordering::Equal))
        });
        entry.peer_prev.retain(|_, (_, _, t)| now.duration_since(*t) < Duration::from_secs(600));
        Ok(rows)
    }

    /// Static facts for the detail panel.
    pub async fn details(&self, id: &str) -> Result<TorrentDetails, String> {
        let map = self.active.lock().await;
        let entry = map.get(id).ok_or("Torrent is not active")?;
        let h = &entry.handle;
        let (total_bytes, total_pieces, piece_length, private, file_count) = h
            .with_metadata(|m| {
                let lengths = m.lengths();
                (
                    lengths.total_length(),
                    lengths.total_pieces(),
                    lengths.default_piece_length(),
                    m.info.info().private,
                    m.file_infos.len(),
                )
            })
            .unwrap_or((0, 0, 0, false, 0));
        let mut trackers: Vec<String> = h.shared().trackers.iter().map(|u| u.to_string()).collect();
        trackers.sort();
        Ok(TorrentDetails {
            info_hash: h.info_hash().as_string(),
            name: h.name(),
            output_folder: h.output_folder().to_string_lossy().into_owned(),
            total_bytes,
            total_pieces,
            piece_length,
            private,
            trackers,
            file_count,
            added_at: entry.added_at.clone(),
            state: h.with_state(|s| s.name().to_string()),
        })
    }

    /// Stop a torrent and drop it from the session. `delete_files` also removes
    /// the data on disk; otherwise a later re-add resumes from what's there.
    /// Returns whether it was active.
    ///
    /// Stopping a *finished* (seeding) torrent is a success, not a cancel: the
    /// download itself completed, the user is only ending the upload phase — so
    /// emit the same success completion the poll loop would, letting the
    /// frontend record it as completed with an openable path.
    pub async fn cancel_torrent(&self, app: &AppHandle, id: &str, delete_files: bool) -> bool {
        let entry = self.active.lock().await.remove(id);
        match entry {
            Some(ActiveTorrent { handle: h, output_dir, .. }) => {
                let stats = h.stats();
                if stats.finished && !delete_files {
                    let file_path = resolve_completion_path(&h, &output_dir);
                    mark_torrent_files_downloaded(&h, &output_dir);
                    log::info!("torrent {id}: seeding stopped by user; completed");
                    let _ = app.emit(
                        &format!("download-complete-{id}"),
                        DownloadComplete {
                            id: id.to_string(),
                            success: true,
                            error: None,
                            file_path,
                            file_size: Some(stats.total_bytes),
                            actual_height: None,
                            output_folder: Some(output_dir),
                        },
                    );
                }
                if let Some(session) = self.session().await {
                    let _ = session.delete(TorrentIdOrHash::from(h.id()), delete_files).await;
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

// ── Add / adopt ─────────────────────────────────────────────────────────

#[derive(Clone)]
struct AddParams {
    source: TorrentSource,
    /// The user's destination. The torrent's *effective* folder is derived
    /// from it per `effective_output_dir` (multi-file torrents get a subfolder).
    output_dir: String,
    only_files: Option<Vec<usize>>,
    download_limit: Option<u64>,
    peer_limit: Option<usize>,
    /// Disk cache for resolved metainfo (see `cache_torrent_bytes`).
    cache_dir: Option<PathBuf>,
    /// Folder name to use when the metainfo can't be resolved before adding.
    fallback_name: String,
}

/// Metainfo bytes for the add, resolving them from the swarm if needed.
///
/// The layout (single file vs multi-file, and the name) decides the output
/// folder, so it has to be known *before* the real add. Bytes are usually in
/// hand already — the file picker ran `list_files`, or an earlier run cached
/// them — and a magnet added without the picker (batch paste, deep link) gets
/// a bounded list-only add here, which is exactly what the picker does.
async fn metainfo_for_add(
    session: &Arc<Session>,
    resolved: &Arc<Mutex<HashMap<String, Vec<u8>>>>,
    p: &AddParams,
) -> Option<Vec<u8>> {
    if let Some(bytes) = resolved.lock().await.get(p.source.key()) {
        return Some(bytes.clone());
    }
    if let TorrentSource::Bytes { bytes, .. } = &p.source {
        return Some(bytes.clone());
    }
    let opts = AddTorrentOptions {
        list_only: true,
        output_folder: Some(p.output_dir.clone()),
        trackers: Some(p.source.trackers()).filter(|t| !t.is_empty()),
        ..Default::default()
    };
    let fetched = tokio::time::timeout(
        Duration::from_secs(45),
        session.add_torrent(p.source.clone().into_add(), Some(opts)),
    )
    .await;
    match fetched {
        Ok(Ok(AddTorrentResponse::ListOnly(lo))) => {
            let bytes = lo.torrent_bytes.to_vec();
            cache_torrent_bytes(p.cache_dir.as_deref(), &lo.info_hash.as_string(), &bytes);
            resolved.lock().await.insert(p.source.key().to_string(), bytes.clone());
            Some(bytes)
        }
        // Restored by the persisted session: its metadata may already be there.
        Ok(Ok(AddTorrentResponse::AlreadyManaged(_, h))) => {
            h.with_metadata(|m| m.torrent_bytes.to_vec()).ok()
        }
        _ => None,
    }
}

/// Add the torrent, or adopt one the persisted session already restored.
/// Returns the handle and the folder its files live in.
async fn add_or_adopt(
    session: &Arc<Session>,
    active: &Arc<Mutex<HashMap<String, ActiveTorrent>>>,
    resolved: &Arc<Mutex<HashMap<String, Vec<u8>>>>,
    p: &AddParams,
) -> Result<(ManagedTorrentHandle, String), String> {
    let bytes = metainfo_for_add(session, resolved, p).await;
    let effective = effective_output_dir(&p.output_dir, bytes.as_deref(), &p.fallback_name);

    // Two *different* torrents must never share a folder — that is the
    // 1.8.0 bug (two flat packs with identical inner file names writing into
    // one file). Same info hash is fine: that's a retry/re-check of this item.
    let our_hash = bytes
        .as_deref()
        .and_then(|b| torrent_from_bytes(b).ok())
        .map(|t| t.info_hash.as_string());
    if !same_dir(std::path::Path::new(&effective), &p.output_dir) {
        let clash = active.lock().await.values().any(|e| {
            same_dir(std::path::Path::new(&e.output_dir), &effective)
                && our_hash.as_deref() != Some(e.handle.info_hash().as_string().as_str())
        });
        if clash {
            return Err(format!(
                "Another torrent is already downloading into \"{}\". Finish or remove it first.",
                std::path::Path::new(&effective)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            ));
        }
    }
    std::fs::create_dir_all(&effective)
        .map_err(|e| format!("Failed to create download directory: {e}"))?;

    // Up to 2 attempts: a resume can race the previous pause's session
    // delete and come back AlreadyManaged — reclaim the orphan and retry.
    let mut attempt = 0;
    loop {
        attempt += 1;
        let add = match &bytes {
            Some(b) => AddTorrent::from_bytes(b.clone()),
            None => p.source.clone().into_add(),
        };
        let opts = AddTorrentOptions {
            output_folder: Some(effective.clone()),
            // None = all files; Some(indices) downloads only the picked ones.
            only_files: p.only_files.clone(),
            // Resume-after-pause re-adds a torrent whose partial files are
            // already on disk; librqbit's storage otherwise opens files with
            // create_new and fails with "file exists". Existing data is
            // hash-checked on add, not blindly trusted or truncated.
            overwrite: true,
            ratelimits: LimitsConfig {
                download_bps: p
                    .download_limit
                    .and_then(|l| NonZeroU32::new(l.min(u32::MAX as u64) as u32)),
                upload_bps: None,
            },
            peer_limit: p.peer_limit,
            trackers: Some(p.source.trackers()).filter(|t| !t.is_empty()),
            ..Default::default()
        };
        match session.add_torrent(add, Some(opts)).await {
            Ok(AddTorrentResponse::Added(_, h)) => return Ok((h, effective)),
            Ok(AddTorrentResponse::AlreadyManaged(managed_id, h)) => {
                // A handle owned by another queue item is a genuine duplicate —
                // cancelling one item must not delete the torrent out from under
                // the other.
                let owned_elsewhere = active
                    .lock()
                    .await
                    .values()
                    .any(|e| e.handle.id() == managed_id);
                if owned_elsewhere {
                    return Err("This torrent is already in the queue.".into());
                }
                // Restored by the persisted session (or a paused run whose delete
                // hasn't settled). If it points at the same folder, adopt it —
                // that's what makes a relaunch resume in seconds instead of
                // re-hashing — otherwise drop it and add afresh. (A torrent
                // persisted by 1.8.0 into the flat destination is therefore
                // re-added into its own folder; the release notes say so.)
                let same_folder = same_dir(h.output_folder(), &effective);
                if same_folder && attempt < 3 {
                    if let Some(files) = &p.only_files {
                        let set: std::collections::HashSet<usize> = files.iter().copied().collect();
                        let _ = session.update_only_files(&h, &set).await;
                    }
                    if h.is_paused() {
                        session.unpause(&h).await.map_err(|e| e.to_string())?;
                    }
                    return Ok((h, effective));
                }
                if attempt >= 2 {
                    return Err("This torrent is already in the queue.".into());
                }
                let _ = session.delete(TorrentIdOrHash::from(managed_id), false).await;
            }
            Ok(AddTorrentResponse::ListOnly(_)) => {
                return Err("Torrent added in list-only mode".into());
            }
            Err(e) => return Err(format!("Failed to add torrent: {e}")),
        }
    }
}

fn same_dir(a: &std::path::Path, b: &str) -> bool {
    let canon = |p: &std::path::Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    canon(a) == canon(std::path::Path::new(b))
}

/// Pause + unpause: librqbit keeps the piece state and issues a fresh
/// `started` announce to every tracker plus a DHT lookup and LSD announce.
async fn reannounce_now(
    session: &Arc<Session>,
    active: &Arc<Mutex<HashMap<String, ActiveTorrent>>>,
    id: &str,
    handle: &ManagedTorrentHandle,
) {
    if handle.is_paused() {
        return;
    }
    fold_uploaded(active, id, handle).await;
    if session.pause(handle).await.is_ok() {
        if let Err(e) = session.unpause(handle).await {
            log::warn!("torrent {id}: unpause after reannounce failed: {e}");
        }
    }
}

/// librqbit's uploaded counter lives in the live state and restarts on every
/// pause; bank it before the state goes away.
async fn fold_uploaded(
    active: &Arc<Mutex<HashMap<String, ActiveTorrent>>>,
    id: &str,
    handle: &ManagedTorrentHandle,
) {
    let live_uploaded = handle.stats().uploaded_bytes;
    if let Some(entry) = active.lock().await.get_mut(id) {
        entry.uploaded_offset = entry.uploaded_offset.saturating_add(live_uploaded);
    }
}

/// Persist `.torrent` bytes as `<dir>/<infohash>.torrent`. Best-effort.
fn cache_torrent_bytes(dir: Option<&std::path::Path>, info_hash: &str, bytes: &[u8]) {
    let Some(dir) = dir else { return };
    if bytes.is_empty() {
        return;
    }
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join(format!("{}.torrent", info_hash.to_ascii_lowercase()));
    if !path.exists() {
        let _ = std::fs::write(path, bytes);
    }
}

fn human_minutes(d: Duration) -> String {
    let m = d.as_secs() / 60;
    if m >= 120 && m % 60 == 0 {
        format!("{} hours", m / 60)
    } else {
        format!("{} minutes", m)
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/// Resolve an openable path for a finished torrent.
///
/// `<output_dir>/<torrent name>` covers single-file torrents (the file — Play
/// works) and torrents with a root folder (Show-in-Folder reveals it). But a
/// flat multi-file torrent writes its files *directly* into `output_dir`, so
/// that path doesn't exist — fall back to the lone file, then to the files'
/// shared top-level component, then to the output directory itself. A `None`
/// here used to leave the Library row with no Play/reveal actions at all.
fn resolve_completion_path(handle: &ManagedTorrentHandle, output_dir: &str) -> Option<String> {
    let base = PathBuf::from(output_dir);
    let existing = |p: PathBuf| p.exists().then(|| p.to_string_lossy().into_owned());

    if let Some(name) = handle.name() {
        if let Some(p) = existing(base.join(&name)) {
            return Some(p);
        }
    }

    let rels: Vec<PathBuf> = handle
        .with_metadata(|m| {
            m.file_infos
                .iter()
                .map(|fi| fi.relative_filename.clone())
                .collect()
        })
        .unwrap_or_default();

    if let [only] = rels.as_slice() {
        if let Some(p) = existing(base.join(only)) {
            return Some(p);
        }
    }
    let mut firsts = rels
        .iter()
        .filter_map(|r| r.components().next().map(|c| c.as_os_str().to_owned()));
    if let Some(first) = firsts.next() {
        if firsts.all(|f| f == first) {
            if let Some(p) = existing(base.join(&first)) {
                return Some(p);
            }
        }
    }

    existing(base)
}

/// Quarantine-flag each file the torrent wrote (file names are untrusted
/// metadata, so an executable payload gets the OS download checks when
/// opened outside Prism). Per file rather than the whole output dir, which
/// may be a folder the user shares with other things.
fn mark_torrent_files_downloaded(handle: &ManagedTorrentHandle, output_dir: &str) {
    let base = PathBuf::from(output_dir);
    let rels: Vec<PathBuf> = handle
        .with_metadata(|m| m.file_infos.iter().map(|fi| fi.relative_filename.clone()).collect())
        .unwrap_or_default();
    for rel in rels {
        let p = base.join(rel);
        if p.is_file() {
            crate::quarantine::mark_downloaded(&p.to_string_lossy());
        }
    }
}

/// Whether seeding is done and the item should complete, per the user's policy
/// and the optional seed-time limit (which applies to every policy but Stop).
pub(crate) fn seeding_complete(
    policy: SeedingPolicy,
    ratio: f64,
    time_limit: Option<Duration>,
    seeded_for: Duration,
) -> bool {
    if matches!(policy, SeedingPolicy::Stop) {
        return true;
    }
    if time_limit.is_some_and(|l| seeded_for >= l) {
        return true;
    }
    match policy {
        SeedingPolicy::Stop => true,
        SeedingPolicy::Ratio(target) => ratio >= target,
        SeedingPolicy::Forever => false,
    }
}

/// Tracks how long a torrent has been *peerless* (live, not finished, zero
/// connected peers, no progress). `tick` is called once per second and returns
/// the current consecutive peerless seconds; any progress or any non-starved
/// tick resets it. `reannounce_due` fires every `REANNOUNCE_EVERY_SECS` of
/// peerlessness; the caller acknowledges with `on_reannounce`.
pub(crate) struct PeerlessWatch {
    last_progress: u64,
    secs: u64,
    since_reannounce: u64,
}

impl PeerlessWatch {
    pub(crate) fn new() -> Self {
        Self { last_progress: 0, secs: 0, since_reannounce: 0 }
    }

    pub(crate) fn tick(&mut self, progress_bytes: u64, starved: bool) -> u64 {
        if progress_bytes > self.last_progress || !starved {
            self.last_progress = self.last_progress.max(progress_bytes);
            self.secs = 0;
            self.since_reannounce = 0;
            return 0;
        }
        self.secs += 1;
        self.since_reannounce += 1;
        self.secs
    }

    pub(crate) fn reannounce_due(&self) -> bool {
        self.secs > 0 && self.since_reannounce >= REANNOUNCE_EVERY_SECS
    }

    pub(crate) fn on_reannounce(&mut self) {
        self.since_reannounce = 0;
    }
}

/// Collapse a have-pieces bitmap into `buckets` bytes, each the fraction
/// (0–255) of its pieces that are present. An empty/degenerate input yields
/// an empty vec so the UI hides the bar.
pub(crate) fn downsample_pieces(have: &[bool], buckets: usize) -> Vec<u8> {
    if have.is_empty() || buckets == 0 {
        return Vec::new();
    }
    let n = have.len();
    let buckets = buckets.min(n);
    (0..buckets)
        .map(|b| {
            let start = b * n / buckets;
            let end = ((b + 1) * n / buckets).max(start + 1).min(n);
            let slice = &have[start..end];
            let got = slice.iter().filter(|&&h| h).count();
            (got * 255 / slice.len()) as u8
        })
        .collect()
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
    log::warn!("torrent {id}: failed: {message}");
    let _ = app.emit(
        &format!("download-complete-{id}"),
        DownloadComplete {
            id: id.to_string(),
            success: false,
            error: Some(crate::errors::classify_output(&message)),
            file_path: None,
            file_size: None,
            actual_height: None,
            output_folder: None,
        },
    );
}

// ── Output folder ───────────────────────────────────────────────────────

/// How a torrent lays its files out, read from its metainfo.
enum TorrentLayout {
    SingleFile,
    MultiFile { name: Option<String>, info_hash: String },
}

fn parse_layout(bytes: &[u8]) -> Option<TorrentLayout> {
    let t = torrent_from_bytes(bytes).ok()?;
    let info_hash = t.info_hash.as_string();
    let info = t.info.data.validate().ok()?;
    // librqbit's own rule: fewer than two files = no subfolder.
    if info.iter_file_details().count() < 2 {
        return Some(TorrentLayout::SingleFile);
    }
    Some(TorrentLayout::MultiFile {
        name: info.name().map(|n| n.into_owned()),
        info_hash,
    })
}

/// Where a torrent's files go. Mirrors librqbit's default when no output
/// folder is given (and every classic client): a multi-file torrent gets its
/// own `<dest>/<name>` folder; a single-file torrent lands in `dest` itself.
/// Prism passes an explicit folder (per-download destinations), which
/// disabled that default — so two flat packs with identical inner names
/// (`02.Race.Session.mp4` in every F1 weekend) wrote into the same files.
///
/// Without metainfo (`bytes` = None: a magnet whose metadata couldn't be
/// fetched in time) the layout is unknown, so the torrent gets a folder named
/// `fallback_name` — one level too many for a single-file torrent, never a
/// collision. The torrent's name is untrusted metadata; it is reduced to a
/// single safe path component before use.
pub(crate) fn effective_output_dir(dest: &str, bytes: Option<&[u8]>, fallback_name: &str) -> String {
    let sub = match bytes.and_then(parse_layout) {
        Some(TorrentLayout::SingleFile) => return dest.to_string(),
        Some(TorrentLayout::MultiFile { name, info_hash }) => name
            .map(|n| safe_folder_name(&n))
            .filter(|n| !n.is_empty())
            .unwrap_or(info_hash),
        None => safe_folder_name(fallback_name),
    };
    let sub = if sub.is_empty() { "torrent".to_string() } else { sub };
    PathBuf::from(dest).join(sub).to_string_lossy().into_owned()
}

/// One path component from an untrusted name: separators, control
/// characters and the characters Windows forbids become `_`; leading and
/// trailing dots/whitespace go (so `..` and `.` can't come back); the length
/// is capped so a hostile name can't exceed filesystem limits.
pub(crate) fn safe_folder_name(raw: &str) -> String {
    const BAD: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    let cleaned: String = raw
        .chars()
        .map(|c| if BAD.contains(&c) || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    trimmed.chars().take(200).collect()
}

/// Folder name for a torrent whose metainfo isn't known at add time: the
/// magnet's display name, else its info hash, else something from the URL.
pub(crate) fn fallback_folder_name(source: &TorrentSource) -> String {
    let from_url = |u: &str| {
        u.trim_end_matches('/')
            .rsplit(['/', '\\'])
            .next()
            .map(|s| s.trim_end_matches(".torrent"))
            .filter(|s| !s.is_empty())
            .unwrap_or("torrent")
            .to_string()
    };
    match source {
        TorrentSource::Url(u) if u.to_ascii_lowercase().starts_with("magnet:") => Magnet::parse(u)
            .ok()
            .and_then(|m| {
                m.name
                    .clone()
                    .filter(|n| !n.trim().is_empty())
                    .or_else(|| m.as_id20().map(|h| h.as_string()))
            })
            .unwrap_or_else(|| "torrent".to_string()),
        TorrentSource::Url(u) => from_url(u),
        TorrentSource::Bytes { key, .. } => from_url(key),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: Option<Duration> = None;
    const ZERO: Duration = Duration::ZERO;

    #[test]
    fn seeding_policy_decisions() {
        assert!(seeding_complete(SeedingPolicy::Stop, 0.0, NONE, ZERO));
        assert!(!seeding_complete(SeedingPolicy::Forever, 999.0, NONE, ZERO));
        assert!(!seeding_complete(SeedingPolicy::Ratio(1.0), 0.99, NONE, ZERO));
        assert!(seeding_complete(SeedingPolicy::Ratio(1.0), 1.0, NONE, ZERO));
        assert!(seeding_complete(SeedingPolicy::Ratio(2.0), 2.5, NONE, ZERO));
    }

    #[test]
    fn seed_time_limit_ends_seeding_for_ratio_and_forever() {
        let limit = Some(Duration::from_secs(60));
        assert!(!seeding_complete(SeedingPolicy::Forever, 0.0, limit, Duration::from_secs(59)));
        assert!(seeding_complete(SeedingPolicy::Forever, 0.0, limit, Duration::from_secs(60)));
        assert!(!seeding_complete(SeedingPolicy::Ratio(5.0), 0.1, limit, Duration::from_secs(10)));
        assert!(seeding_complete(SeedingPolicy::Ratio(5.0), 0.1, limit, Duration::from_secs(61)));
    }

    #[test]
    fn peerless_counts_only_consecutive_starved_ticks() {
        let mut w = PeerlessWatch::new();
        // Progress each tick → never peerless, even with zero peers.
        assert_eq!(w.tick(10, true), 0);
        assert_eq!(w.tick(20, true), 0);
        // Frozen and peerless: counts up.
        assert_eq!(w.tick(20, true), 1);
        assert_eq!(w.tick(20, true), 2);
        // Peers connected / hash-checking / seeding → reset.
        assert_eq!(w.tick(20, false), 0);
        assert_eq!(w.tick(20, true), 1);
        // Progress → reset.
        assert_eq!(w.tick(100, true), 0);
    }

    #[test]
    fn peerless_never_fails_by_itself_but_reannounces_on_cadence() {
        let mut w = PeerlessWatch::new();
        for _ in 0..(REANNOUNCE_EVERY_SECS - 1) {
            w.tick(0, true);
            assert!(!w.reannounce_due());
        }
        w.tick(0, true);
        assert!(w.reannounce_due());
        w.on_reannounce();
        assert!(!w.reannounce_due());
        // Keeps counting (the UI shows the elapsed time); due again a cadence later.
        for _ in 0..REANNOUNCE_EVERY_SECS {
            w.tick(0, true);
        }
        assert!(w.reannounce_due());
        assert!(w.tick(0, true) > 2 * REANNOUNCE_EVERY_SECS);
    }

    #[test]
    fn pieces_downsample_to_fill_fractions() {
        assert!(downsample_pieces(&[], 10).is_empty());
        let all = vec![true; 400];
        assert!(downsample_pieces(&all, 4).iter().all(|&b| b == 255));
        let none = vec![false; 400];
        assert!(downsample_pieces(&none, 4).iter().all(|&b| b == 0));
        // First half have, second half not.
        let mut half = vec![true; 200];
        half.extend(vec![false; 200]);
        assert_eq!(downsample_pieces(&half, 4), vec![255, 255, 0, 0]);
        // Fewer pieces than buckets: one bucket per piece.
        assert_eq!(downsample_pieces(&[true, false, true], 200), vec![255, 0, 255]);
    }

    #[test]
    fn human_minutes_reads_naturally() {
        assert_eq!(human_minutes(Duration::from_secs(60)), "1 minutes");
        assert_eq!(human_minutes(Duration::from_secs(90 * 60)), "90 minutes");
        assert_eq!(human_minutes(Duration::from_secs(3 * 3600)), "3 hours");
    }

    // Minimal bencoded metainfo. One 16 KiB piece covers every file here, so
    // `pieces` is a single 20-byte hash (validation checks the count).
    fn single_file_torrent(name: &str) -> Vec<u8> {
        let mut b = format!("d4:infod6:lengthi10e4:name{}:{}12:piece lengthi16384e6:pieces20:", name.len(), name).into_bytes();
        b.extend([0u8; 20]);
        b.extend(b"ee");
        b
    }

    fn multi_file_torrent(name: &str, files: &[&str]) -> Vec<u8> {
        let mut b = b"d4:infod5:filesl".to_vec();
        for f in files {
            b.extend(format!("d6:lengthi5e4:pathl{}:{}ee", f.len(), f).into_bytes());
        }
        b.extend(format!("e4:name{}:{}12:piece lengthi16384e6:pieces20:", name.len(), name).into_bytes());
        b.extend([0u8; 20]);
        b.extend(b"ee");
        b
    }

    #[test]
    fn multi_file_torrents_get_their_own_folder() {
        let dest = "/tmp/dl";
        let abu = multi_file_torrent("F1.2024x24.Abu-Dhabi", &["01.Buildup.mp4", "02.Race.mp4"]);
        let qatar = multi_file_torrent("F1.2024x23.Qatar", &["01.Buildup.mp4", "02.Race.mp4"]);
        let a = effective_output_dir(dest, Some(&abu), "fallback");
        let q = effective_output_dir(dest, Some(&qatar), "fallback");
        assert_eq!(a, "/tmp/dl/F1.2024x24.Abu-Dhabi");
        assert_eq!(q, "/tmp/dl/F1.2024x23.Qatar");
        assert_ne!(a, q, "same inner file names must never share a folder");
    }

    #[test]
    fn single_file_torrents_stay_in_the_destination() {
        let t = single_file_torrent("debian.iso");
        assert_eq!(effective_output_dir("/tmp/dl", Some(&t), "fallback"), "/tmp/dl");
        // A `files` list with one entry counts as single-file too (librqbit's rule).
        let one = multi_file_torrent("Pack", &["only.mkv"]);
        assert_eq!(effective_output_dir("/tmp/dl", Some(&one), "fallback"), "/tmp/dl");
    }

    #[test]
    fn unknown_layout_uses_the_fallback_name() {
        assert_eq!(effective_output_dir("/tmp/dl", None, "Some Magnet"), "/tmp/dl/Some Magnet");
        assert_eq!(effective_output_dir("/tmp/dl", Some(b"not a torrent"), "x"), "/tmp/dl/x");
        // A fallback that sanitizes to nothing still yields a subfolder.
        assert_eq!(effective_output_dir("/tmp/dl", None, ".."), "/tmp/dl/torrent");
    }

    #[test]
    fn hostile_names_become_one_safe_component() {
        let t = multi_file_torrent("../../evil", &["a", "b"]);
        assert_eq!(effective_output_dir("/tmp/dl", Some(&t), "f"), "/tmp/dl/_.._evil");
        assert_eq!(safe_folder_name("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(safe_folder_name("  .hidden.  "), "hidden");
        assert_eq!(safe_folder_name("con\u{0}trol"), "con_trol");
        assert_eq!(safe_folder_name("..").len(), 0);
        assert_eq!(safe_folder_name(&"x".repeat(500)).len(), 200);
    }

    #[test]
    fn fallback_name_comes_from_the_magnet_or_url() {
        let dn = TorrentSource::Url("magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=My%20Show".into());
        assert_eq!(fallback_folder_name(&dn), "My Show");
        let bare = TorrentSource::Url("magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a".into());
        assert_eq!(fallback_folder_name(&bare), "c12fe1c06bba254a9dc9f519b335aa7c1367a88a");
        let http = TorrentSource::Url("https://example.com/files/thing.torrent".into());
        assert_eq!(fallback_folder_name(&http), "thing");
        let file = TorrentSource::Bytes { key: "/Users/x/Downloads/pack.torrent".into(), bytes: vec![], trackers: vec![] };
        assert_eq!(fallback_folder_name(&file), "pack");
    }
}
