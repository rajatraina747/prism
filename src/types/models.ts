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
}

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
  launchOnStartup: boolean;
  minimizeToTray: boolean;
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
  // Torrent seeding: what to do once a torrent finishes downloading.
  // 'stop' = stop uploading immediately, 'ratio' = seed until share ratio 1.0
  // (good swarm citizen, bounded upload), 'seed' = seed until manually stopped.
  // Read by the Rust side from settings.json (whitelisted), like audioFormat.
  seedingPolicy: 'stop' | 'ratio' | 'seed';
  // Optional proxy for all traffic. yt-dlp accepts http(s)/socks; torrents only
  // use it when it's a socks5:// URL. Empty = direct. Validated Rust-side.
  proxyUrl: string;
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
  filePath?: string;
  error?: DownloadError;
  /** Torrent only: downloaded files (paths relative to settings.destination),
   * so the Library can play/reveal each one individually. */
  files?: { name: string; size: number }[];
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
  launchOnStartup: false,
  minimizeToTray: true,
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
  seedingPolicy: 'ratio',
  proxyUrl: '',
  extraTrackers: '',
  blocklistUrl: '',
  perSitePresets: {},
};

export const DEFAULT_PRESETS: DownloadPreset[] = [
  { id: 'best', name: 'Best Quality', resolution: 'Best', container: 'mp4', quality: 'best' },
  { id: '4k', name: '4K Ultra HD', resolution: '2160p', container: 'mp4', quality: 'best' },
  { id: '1080p', name: 'Full HD', resolution: '1080p', container: 'mp4', quality: 'high' },
  { id: '720p', name: 'HD Ready', resolution: '720p', container: 'mp4', quality: 'medium' },
  { id: 'compact', name: 'Compact', resolution: '480p', container: 'mp4', quality: 'low' },
];
