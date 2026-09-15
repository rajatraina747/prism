export type DownloadStatus =
  | 'queued'
  | 'parsing'
  | 'ready'
  | 'downloading'
  // Torrent-only: download hit 100% but is still uploading to the swarm.
  // Terminal-ish — transitions to 'completed' when seeding stops (ratio met
  // or user action). See seedingPolicy.
  | 'seeding'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled';

// How an item is fetched. Absent = 'http' (yt-dlp), the default for every
// existing item. 'torrent' routes through the librqbit engine instead.
export type DownloadKind = 'http' | 'torrent';

// One file inside a (multi-file) torrent, with per-file progress percent.
export interface TorrentFileInfo {
  name: string;
  size: number;
  progress: number;
}

// A file listed from a torrent's metadata before downloading (file picker).
// `index` is what the engine's file selection expects.
export interface TorrentFileEntry {
  index: number;
  name: string;
  size: number;
}

export interface MediaSource {
  url: string;
  domain: string;
  addedAt: string;
}

export interface FormatOption {
  id: string;
  label: string;
  resolution: string;
  container: string;
  codec: string;
  fileSize: number;
  quality: 'best' | 'high' | 'medium' | 'low';
}

export interface MediaMetadata {
  title: string;
  duration: number;
  thumbnail: string;
  source: MediaSource;
  formats: FormatOption[];
  description?: string;
  uploader?: string;
}

export interface DownloadSettings {
  format: FormatOption | null;
  destination: string;
  filename: string;
  retryCount: number;
  startImmediately: boolean;
  audioOnly?: boolean;
  downloadSubtitles?: boolean;
  subtitleLanguage?: string;
  speedLimit?: number; // bytes per second, 0 = unlimited
  // Torrent-only: indices of files to download. Undefined = all files.
  selectedFiles?: number[];
}

export interface PlaylistEntry {
  url: string;
  title: string;
  duration: number;
  thumbnail: string;
}

export interface PlaylistInfo {
  title: string;
  entries: PlaylistEntry[];
}

export interface DownloadItem {
  id: string;
  metadata: MediaMetadata;
  settings: DownloadSettings;
  status: DownloadStatus;
  progress: number;
  speed: number;
  eta: number;
  downloadedBytes: number;
  totalBytes: number;
  startedAt?: string;
  completedAt?: string;
  filePath?: string;
  /** Video height actually delivered (reported by yt-dlp at completion) —
   * compared against settings.format to flag silent quality degradation. */
  actualHeight?: number;
  error?: DownloadError;
  retryAttempt: number;
  // 'processing' while yt-dlp hands off to ffmpeg (merge/extract/embed) —
  // bytes stop moving but the download isn't done. Absent otherwise.
  stage?: 'processing';
  // Source engine. Absent/'http' = yt-dlp; 'torrent' = librqbit. The torrent
  // fields below are only populated while kind === 'torrent'.
  kind?: DownloadKind;
  peers?: number;
  // Swarm health: peers discovered / mid-handshake. 0 connected + 0 seen =
  // dead swarm; 0 connected + many seen = connectivity problem.
  peersSeen?: number;
  peersConnecting?: number;
  uploadSpeed?: number; // bytes per second
  ratio?: number; // uploaded / downloaded
  files?: TorrentFileInfo[]; // multi-file torrent breakdown
  /** Lifetime bytes uploaded (survives pause/reannounce, unlike the engine's counter). */
  uploadedBytes?: number;
  /** Consecutive seconds with zero connected peers; 0 while connected. */
  peerlessSecs?: number;
  /** Have-pieces bitmap downsampled to ~200 buckets (0–255 fill). Not persisted. */
  pieces?: number[];
  /** When the item entered the queue (set by the reducer on add). */
  addedAt?: string;
  /** Torrent only: the folder the files were written to. A multi-file torrent
   * gets its own `<destination>/<name>` folder, so `files[].name` (relative
   * to this) must be joined against it, not against settings.destination. */
  outputFolder?: string;
}

/** One peer of a live torrent (Peers tab). Speeds are differenced per poll. */
export interface TorrentPeer {
  addr: string;
  client?: string | null;
  kind: string; // tcp | utp | socks | unknown
  state: string; // queued | connecting | live | dead | not needed
  downBps: number;
  upBps: number;
  downloaded: number;
  uploaded: number;
  errors: number;
}

/** Static facts about an active torrent (General/Trackers tabs). */
export interface TorrentDetails {
  infoHash: string;
  name?: string | null;
  outputFolder: string;
  totalBytes: number;
  totalPieces: number;
  pieceLength: number;
  private: boolean;
  trackers: string[];
  fileCount: number;
  addedAt: string;
  state: string;
}

/** Session-wide torrent engine numbers (transfers footer). */
export interface SessionStats {
  downloadBps: number;
  uploadBps: number;
  peersLive: number;
  peersConnecting: number;
  peersSeen: number;
  dhtNodes: number;
  listenPort?: number | null;
  upnp: boolean;
  dht: boolean;
  utp: boolean;
  activeTorrents: number;
}

export type TransfersSort = 'added' | 'name' | 'progress' | 'speed' | 'eta' | 'size' | 'ratio';
export type TransfersFilter = 'all' | 'downloading' | 'seeding' | 'paused' | 'queued' | 'errored';

export interface DownloadError {
  code: string;
  message: string;
  category: 'network' | 'parse' | 'permission' | 'storage' | 'auth' | 'unknown';
  timestamp: string;
  suggestion?: string;
}

export interface DownloadPreset {
  id: string;
  name: string;
  resolution: string;
  container: string;
  quality: string;
}

export interface AppPreferences {
  defaultSaveFolder: string;
  maxConcurrentDownloads: number;
  bandwidthLimit: number;
  defaultRetryCount: number;
  theme: 'dark' | 'light' | 'system';
  autoUpdate: boolean;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  notificationsEnabled: boolean;
  soundEnabled: boolean;
  cookiesFromBrowser: 'none' | 'safari' | 'chrome' | 'firefox' | 'edge' | 'brave';
  subscriptionCheckIntervalMinutes: number;
  // SponsorBlock (crowd-sourced sponsor-segment data): 'mark' adds chapter
  // markers for the segments, 'remove' cuts them out of the file. Read by the
  // Rust side directly from settings.json, like cookiesFromBrowser.
  sponsorBlock: 'off' | 'mark' | 'remove';
  // Quiet hours: between start and end hour, hold new downloads ('pause') or
  // start them throttled ('limit'). See src/stores/schedule.ts.
  scheduleEnabled: boolean;
  scheduleStartHour: number;
  scheduleEndHour: number;
  scheduleMode: 'pause' | 'limit';
  scheduleLimitMBps: number;
  // Opt-in crash reporting (Sentry). Off by default; also requires the app to
  // have been built with a DSN. Frontend toggles live; Rust panics follow the
  // setting on next launch.
  crashReportingEnabled: boolean;
  // Container/codec for audio-only downloads. Read by the Rust side from
  // settings.json (whitelisted), like cookiesFromBrowser.
  audioFormat: 'mp3' | 'm4a' | 'opus';
  // Video: skip the forced MP4 remux so VP9/AV1 stay in mkv/webm (some
  // players mishandle those codecs inside .mp4). Read Rust-side. Default off.
  keepOriginalContainer: boolean;
  // First-run setup card on the Dashboard (destination, ffmpeg, cookies).
  setupCardDismissed: boolean;
  // Torrent seeding: what to do once a torrent finishes downloading.
  // 'stop' = stop uploading immediately, 'ratio' = seed until share ratio 1.0
  // (good swarm citizen, bounded upload), 'seed' = seed until manually stopped.
  // Read by the Rust side from settings.json (whitelisted), like audioFormat.
  seedingPolicy: 'stop' | 'ratio' | 'seed';
  // Optional proxy. yt-dlp routes everything through http(s)/socks proxies;
  // the torrent engine routes only *peer connections* through a socks5://
  // proxy (DHT, trackers and the .torrent/blocklist fetches go direct, and
  // http proxies are ignored for torrents). Empty = direct. Validated Rust-side.
  proxyUrl: string;
  // Torrent engine: open a router port via UPnP for inbound peers (better
  // swarm health, but publishes this machine's reachability). Read Rust-side.
  torrentUpnp: boolean;
  // Torrent engine: join the DHT (off = tracker-only). Read Rust-side.
  torrentDht: boolean;
  // Torrent engine (all read Rust-side at engine start, i.e. next launch):
  // uTP transport alongside TCP; LAN peer discovery; fixed listen port; max
  // peers per torrent (0 = engine default).
  torrentUtp: boolean;
  torrentLsd: boolean;
  torrentListenPort: number;
  torrentPeerLimit: number;
  // Give up on a torrent that has had no peers for N minutes (0 = never —
  // it keeps re-announcing every 5 minutes, like uTorrent/Vuze). Rust-side.
  torrentGiveUpMinutes: number;
  // Seeding: ratio target for the 'ratio' policy, and an optional wall-clock
  // limit (minutes, 0 = none) that ends seeding under any policy but 'stop'.
  seedRatioTarget: number;
  seedTimeLimitMinutes: number;
  // Session-wide torrent speed caps in KB/s (0 = unlimited). Applied live;
  // the quiet-hours override caps them further while active.
  torrentDownloadLimitKBps: number;
  torrentUploadLimitKBps: number;
  // Transfers page memory.
  transfersSort: TransfersSort;
  transfersFilter: TransfersFilter;
  detailPanelHeight: number;
  // Offer to fetch video URLs found on the clipboard when the window regains
  // focus. Reads the clipboard, so it's a user choice.
  clipboardWatchEnabled: boolean;
  // Extra tracker announce URLs added to every torrent (newline- or comma-
  // separated). Helps peer discovery on magnets with dead/few trackers.
  // Read by the Rust side from settings.json (filtered to http(s)/udp).
  extraTrackers: string;
  // IP blocklist URL for the torrent engine (standard p2p formats, gz ok).
  // Applied when the engine starts — takes effect on next launch. Empty = off.
  blocklistUrl: string;
  // Remembered quality preset per domain (host -> preset id). When you add a URL
  // from a site you've used before, its last-used preset is pre-selected.
  perSitePresets: Record<string, string>;
  // Pass --force-ipv4 to yt-dlp (lookups and downloads). Many sites throttle
  // IPv6 downloads; on by default, which was the hardcoded behaviour before
  // 1.9. Read Rust-side.
  forceIpv4: boolean;
}

export interface DiagnosticsEntry {
  id: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

// A watched channel/playlist. New entries (relative to seenUrls) are enqueued
// automatically on each check. seenUrls is seeded at subscribe time so only
// videos published *after* subscribing are downloaded.
export interface Subscription {
  id: string;
  url: string;
  title: string;
  addedAt: string;
  enabled: boolean;
  audioOnly: boolean;
  seenUrls: string[];
  lastCheckedAt?: string;
  lastError?: string;
}

export interface HistoryItem {
  id: string;
  metadata: MediaMetadata;
  settings: DownloadSettings;
  status: 'completed' | 'failed' | 'canceled';
  completedAt: string;
  fileSize: number;
  /** Total size when known — lets a retry start with the real size instead
   * of a placeholder (torrents otherwise need peers just to learn it). */
  totalBytes?: number;
  filePath?: string;
  error?: DownloadError;
  /** Torrent only: downloaded files (paths relative to `outputFolder`, or to
   * settings.destination for items recorded before 1.8.1), so the Library can
   * play/reveal each one individually. */
  files?: { name: string; size: number }[];
  /** Torrent only: see DownloadItem.outputFolder. */
  outputFolder?: string;
  /** Video height actually delivered, when it differs from what the format
   * label promised (see DownloadItem.actualHeight). */
  actualHeight?: number;
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  defaultSaveFolder: '~/Downloads/Prism',
  maxConcurrentDownloads: 3,
  bandwidthLimit: 0,
  defaultRetryCount: 3,
  theme: 'dark',
  autoUpdate: true,
  logLevel: 'info',
  notificationsEnabled: true,
  soundEnabled: false,
  cookiesFromBrowser: 'none',
  subscriptionCheckIntervalMinutes: 30,
  sponsorBlock: 'off',
  scheduleEnabled: false,
  scheduleStartHour: 8,
  scheduleEndHour: 23,
  scheduleMode: 'limit',
  scheduleLimitMBps: 5,
  crashReportingEnabled: false,
  audioFormat: 'mp3',
  keepOriginalContainer: false,
  setupCardDismissed: false,
  seedingPolicy: 'ratio',
  proxyUrl: '',
  torrentUpnp: true,
  torrentDht: true,
  torrentUtp: false,
  torrentLsd: true,
  torrentListenPort: 4240,
  torrentPeerLimit: 0,
  torrentGiveUpMinutes: 0,
  seedRatioTarget: 1,
  seedTimeLimitMinutes: 0,
  torrentDownloadLimitKBps: 0,
  torrentUploadLimitKBps: 0,
  transfersSort: 'added',
  transfersFilter: 'all',
  detailPanelHeight: 260,
  clipboardWatchEnabled: true,
  extraTrackers: '',
  blocklistUrl: '',
  perSitePresets: {},
  forceIpv4: true,
};

export const DEFAULT_PRESETS: DownloadPreset[] = [
  { id: 'best', name: 'Best Quality', resolution: 'Best', container: 'mp4', quality: 'best' },
  { id: '4k', name: '4K Ultra HD', resolution: '2160p', container: 'mp4', quality: 'best' },
  { id: '1080p', name: 'Full HD', resolution: '1080p', container: 'mp4', quality: 'high' },
  { id: '720p', name: 'HD Ready', resolution: '720p', container: 'mp4', quality: 'medium' },
  { id: 'compact', name: 'Compact', resolution: '480p', container: 'mp4', quality: 'low' },
];
