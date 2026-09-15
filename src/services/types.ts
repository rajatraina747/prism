import type { MediaMetadata, DownloadItem, HistoryItem, AppPreferences, DiagnosticsEntry, PlaylistInfo, Subscription, TorrentFileInfo, TorrentFileEntry, TorrentPeer, TorrentDetails, SessionStats } from '@/types/models';
import type { EngineError } from '@/services/errors';

export type ProgressCallback = (data: {
  downloadedBytes: number;
  totalBytes: number;
  progress: number;
  speed: number;
  eta: number;
  // HTTP-only: 'processing' while ffmpeg merges/extracts/embeds. The key is
  // always sent (possibly undefined) so a stale stage clears on the next tick.
  stage?: 'processing';
  // Torrent-only swarm stats; undefined for HTTP downloads.
  uploadSpeed?: number;
  peers?: number;
  peersSeen?: number;
  peersConnecting?: number;
  ratio?: number;
  files?: TorrentFileInfo[];
  uploadedBytes?: number;
  peerlessSecs?: number;
  pieces?: number[];
  // Torrent-only: download finished, now seeding. Drives downloading→seeding.
  seeding?: boolean;
}) => void;

export type CompletionCallback = (
  success: boolean,
  /** A structured EngineError from Rust; the web demo passes plain text. */
  error?: EngineError | string,
  filePath?: string,
  fileSize?: number,
  actualHeight?: number,
  /** Torrents: the folder the files were written to (a multi-file torrent
   * gets its own `<destination>/<name>` folder). */
  outputFolder?: string,
) => void;

/** Where a link came from. `external`: the OS handed it to Prism (a browser's
 * magnet:/prism:// link, a .torrent opened from Finder/Explorer) — nothing
 * proves the user meant it, so the UI confirms before any network action.
 * `app`: the user put it there inside Prism (tray Paste & Download, a drop). */
export type LinkOrigin = 'external' | 'app';

/** Mirrors `EngineInfo` in src-tauri/src/engine.rs. */
export interface EngineInfo {
  active: 'managed' | 'bundled';
  /** Null for a self-updated engine from before 2.0 (version never recorded). */
  activeVersion: string | null;
  bundledVersion: string;
  managedVersion: string | null;
  latest: string | null;
  checkedAt: string | null;
  updateAvailable: boolean;
}

/** Mirrors `LinkProbe` in src-tauri/src/http_engine.rs. */
export interface LinkProbe {
  finalUrl: string;
  filename: string;
  size: number | null;
  acceptRanges: boolean;
  contentType: string | null;
}

export interface UpdateCheckResult {
  available: boolean;
  version?: string;
  notes?: string;
  error?: string;
}

export interface IPrismService {
  // Initialize the service (preload persistence data from disk)
  init?(): Promise<void>;
  /** True for the browser demo (simulated downloads, localStorage). The
   * shell shows a badge so a mock can never pass for the real app. */
  readonly isDemo?: boolean;

  // URL parsing & metadata
  parseUrl(url: string): Promise<MediaMetadata>;
  /** Flat-parse a playlist/channel feed. `limit` caps to the newest N entries
   * (used by subscription polling; omit for full imports). */
  parsePlaylist(url: string, limit?: number): Promise<PlaylistInfo>;
  /** List a torrent's files without downloading (for the file picker). `dest`
   * is the intended destination directory. */
  parseTorrent(magnet: string, dest: string): Promise<TorrentFileEntry[]>;

  // Download lifecycle — returns a cancel/cleanup function
  startDownload(
    item: DownloadItem,
    onProgress: ProgressCallback,
    onComplete: CompletionCallback,
  ): () => void;

  pauseDownload(id: string): Promise<void>;
  cancelDownload(id: string): Promise<void>;
  /** Torrent-only: pause/resume in place. The engine keeps the torrent in its
   * session, so resuming needs no re-add and no hash re-check. Rejects if the
   * torrent isn't active (caller falls back to the kill-and-requeue path). */
  pauseTorrent(id: string): Promise<void>;
  resumeTorrent(id: string): Promise<void>;
  /** Torrent-only: change which files download, mid-torrent. Rejects when the
   * torrent isn't active or the selection is empty. */
  updateTorrentFiles(id: string, onlyFiles: number[]): Promise<void>;
  /** Session-wide torrent caps (bytes/sec; null = unlimited). The provider
   * merges the user's limits with Quiet Hours and pushes the effective pair. */
  setTorrentRateLimits(downloadBps: number | null, uploadBps: number | null): Promise<void>;
  /** Live session-wide cap for direct downloads (quiet hours); null = none. */
  setDirectRateLimit(bytesPerSecond: number | null): Promise<void>;
  /** "Update tracker": fresh announce to trackers/DHT/LSD; keeps progress. */
  reannounceTorrent(id: string): Promise<void>;
  /** "Force re-check": hash every piece on disk again. */
  recheckTorrent(id: string): Promise<void>;
  /** Stop a torrent and delete its files from disk. */
  removeTorrentData(id: string): Promise<void>;
  /** Peers of a live torrent (Peers tab; poll while visible). */
  getTorrentPeers(id: string): Promise<TorrentPeer[]>;
  /** Static facts about an active torrent (detail panel). */
  getTorrentDetails(id: string): Promise<TorrentDetails>;
  /** Session-wide engine stats stream (transfers footer). Returns unsubscribe. */
  onSessionStats(handler: (stats: SessionStats) => void): () => void;

  // File system operations
  openFile(filePath: string): Promise<void>;
  showInFolder(filePath: string): Promise<void>;
  /** Open an http(s) link in the user's browser — `target="_blank"` is inert
   *  inside the webview, so every outbound link goes through this. */
  openExternal(url: string): Promise<void>;
  pickDirectory(): Promise<string | null>;
  getDefaultDownloadPath(): Promise<string>;

  // Clipboard
  copyToClipboard(text: string): Promise<void>;
  readClipboard(): Promise<string>;

  /** OS-level notification — reaches the user when the window is hidden or in
   * the tray, where in-app toasts are invisible. Best-effort (no-op if the OS
   * denies permission). */
  notify(title: string, body: string): Promise<void>;

  // Deep links (prism://add?url=..., magnet:, .torrent files, tray paste) —
  // handler receives the extracted URL and where it came from.
  // Returns an unsubscribe function.
  onDeepLink(handler: (url: string, origin: LinkOrigin) => void): () => void;
  /** A dropped `.torrent` (bytes only — drops carry no path). Returns a magnet
   * for it; the engine adds it from the stored bytes. */
  importTorrentFile(name: string, bytes: Uint8Array): Promise<string>;
  /** Native "Open .torrent" picker; null when cancelled or unavailable. */
  pickTorrentFile(): Promise<string | null>;

  // System
  exportLogs(logs: DiagnosticsEntry[]): Promise<void>;
  /** Whether ffmpeg is installed — merges, embedding, and SponsorBlock need it. */
  ffmpegAvailable(): Promise<boolean>;
  checkForUpdates(): Promise<UpdateCheckResult>;
  installUpdate(onProgress?: (downloaded: number, total: number | null) => void): Promise<void>;
  getAppVersion(): Promise<string>;

  // yt-dlp engine management — the engine can be updated independently of the app
  getEngineVersion(): Promise<string>;
  updateEngine(): Promise<string>;
  resetEngine(): Promise<void>;
  /** Which engine runs and whether a newer yt-dlp exists (no network). */
  getEngineInfo(): Promise<EngineInfo>;
  /** Ask GitHub for the newest yt-dlp; reuses a lookup under a day old unless `force`. */
  checkEngineUpdate(force?: boolean): Promise<EngineInfo>;
  /** What an http(s) link points at — a file (name, size) or a web page. */
  probeDirectLink(url: string): Promise<LinkProbe>;

  // Persistence
  persistence: {
    loadQueue(): DownloadItem[];
    saveQueue(items: DownloadItem[]): void;
    loadHistory(): HistoryItem[];
    saveHistory(items: HistoryItem[]): void;
    loadSettings(): AppPreferences | null;
    saveSettings(prefs: AppPreferences): void;
    loadSubscriptions(): Subscription[];
    saveSubscriptions(subs: Subscription[]): void;
  };
}
