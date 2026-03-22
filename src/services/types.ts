import type { MediaMetadata, DownloadItem, HistoryItem, AppPreferences, DiagnosticsEntry, PlaylistInfo } from '@/types/models';

export type ProgressCallback = (data: {
  downloadedBytes: number;
  totalBytes: number;
  progress: number;
  speed: number;
  eta: number;
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
  parsePlaylist(url: string): Promise<PlaylistInfo>;

  // Download lifecycle — returns a cancel/cleanup function
  startDownload(
    item: DownloadItem,
    onProgress: ProgressCallback,
    onComplete: CompletionCallback,
  ): () => void;

  pauseDownload(id: string): Promise<void>;
  cancelDownload(id: string): Promise<void>;

  // File system operations
  openFile(filePath: string): Promise<void>;
  showInFolder(filePath: string): Promise<void>;
  pickDirectory(): Promise<string | null>;
  getDefaultDownloadPath(): Promise<string>;

  // Clipboard
  copyToClipboard(text: string): Promise<void>;

  // System
  exportLogs(logs: DiagnosticsEntry[]): Promise<void>;
  checkForUpdates(): Promise<UpdateCheckResult>;
  installUpdate(onProgress?: (downloaded: number, total: number | null) => void): Promise<void>;
  getAppVersion(): Promise<string>;

  // Persistence
  persistence: {
    loadQueue(): DownloadItem[];
    saveQueue(items: DownloadItem[]): void;
    loadHistory(): HistoryItem[];
    saveHistory(items: HistoryItem[]): void;
    loadSettings(): AppPreferences | null;
    saveSettings(prefs: AppPreferences): void;
  };
}
