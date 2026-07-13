import type { MediaMetadata, DownloadItem, HistoryItem, AppPreferences, DiagnosticsEntry, PlaylistInfo, Subscription, TorrentFileInfo, TorrentFileEntry } from '@/types/models';

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
  // Torrent-only: download finished, now seeding. Drives downloading→seeding.
  seeding?: boolean;
}) => void;

export type CompletionCallback = (success: boolean, error?: string, filePath?: string, fileSize?: number) => void;

export interface UpdateCheckResult {
  available: boolean;
  version?: string;
  notes?: string;
  error?: string;
}

export interface IPrismService {
  // Initialize the service (preload persistence data from disk)
  init?(): Promise<void>;

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
  /** Throttle the torrent engine session-wide (bytes/sec; null = unlimited).
   * Applies to download and seed upload. Driven by Quiet Hours. */
  setTorrentRateLimit(bytesPerSec: number | null): Promise<void>;

  // File system operations
  openFile(filePath: string): Promise<void>;
  showInFolder(filePath: string): Promise<void>;
  pickDirectory(): Promise<string | null>;
  getDefaultDownloadPath(): Promise<string>;

  // Clipboard
  copyToClipboard(text: string): Promise<void>;
  readClipboard(): Promise<string>;

  /** OS-level notification — reaches the user when the window is hidden or in
   * the tray, where in-app toasts are invisible. Best-effort (no-op if the OS
   * denies permission). */
  notify(title: string, body: string): Promise<void>;

  // Deep links (prism://add?url=...) — handler receives the extracted video URL.
  // Returns an unsubscribe function.
  onDeepLink(handler: (url: string) => void): () => void;

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
