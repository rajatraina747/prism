import type { MediaMetadata, DownloadItem, HistoryItem, AppPreferences, DiagnosticsEntry, PlaylistInfo, Subscription, TorrentFileInfo } from '@/types/models';

export type ProgressCallback = (data: {
  downloadedBytes: number;
  totalBytes: number;
  progress: number;
  speed: number;
  eta: number;
  // Torrent-only swarm stats; undefined for HTTP downloads.
  uploadSpeed?: number;
  peers?: number;
  seeds?: number;
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

  // Download lifecycle — returns a cancel/cleanup function
  startDownload(
    item: DownloadItem,
    onProgress: ProgressCallback,
    onComplete: CompletionCallback,
  ): () => void;

  pauseDownload(id: string): Promise<void>;
  cancelDownload(id: string): Promise<void>;
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

  // Deep links (prism://add?url=...) — handler receives the extracted video URL.
  // Returns an unsubscribe function.
  onDeepLink(handler: (url: string) => void): () => void;

  // System
  exportLogs(logs: DiagnosticsEntry[]): Promise<void>;
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
