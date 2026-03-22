export type DownloadStatus =
  | 'queued'
  | 'parsing'
  | 'ready'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled';

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
  priority: 'high' | 'normal' | 'low';
  retryCount: number;
  startImmediately: boolean;
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
  error?: DownloadError;
  retryAttempt: number;
}

export interface DownloadError {
  code: string;
  message: string;
  category: 'network' | 'parse' | 'permission' | 'storage' | 'unknown';
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
  namingTemplate: string;
  overwriteBehavior: 'rename' | 'overwrite' | 'skip';
  maxConcurrentDownloads: number;
  bandwidthLimit: number;
  defaultRetryCount: number;
  clipboardAutoDetect: boolean;
  theme: 'dark' | 'light' | 'system';
  launchOnStartup: boolean;
  minimizeToTray: boolean;
  autoUpdate: boolean;
  updateChannel: 'stable' | 'beta';
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  notificationsEnabled: boolean;
  soundEnabled: boolean;
}

export interface DiagnosticsEntry {
  id: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

export interface QueueState {
  items: DownloadItem[];
  activeCount: number;
  isPaused: boolean;
}

export interface HistoryItem {
  id: string;
  metadata: MediaMetadata;
  settings: DownloadSettings;
  status: 'completed' | 'failed' | 'canceled';
  completedAt: string;
  fileSize: number;
  error?: DownloadError;
}

export interface UpdatePreferences {
  autoCheck: boolean;
  autoInstall: boolean;
  channel: 'stable' | 'beta';
  lastChecked?: string;
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  defaultSaveFolder: '~/Downloads/Prism',
  namingTemplate: '{title}',
  overwriteBehavior: 'rename',
  maxConcurrentDownloads: 3,
  bandwidthLimit: 0,
  defaultRetryCount: 3,
  clipboardAutoDetect: true,
  theme: 'dark',
  launchOnStartup: false,
  minimizeToTray: true,
  autoUpdate: true,
  updateChannel: 'stable',
  logLevel: 'info',
  notificationsEnabled: true,
  soundEnabled: false,
};

export const DEFAULT_PRESETS: DownloadPreset[] = [
  { id: 'best', name: 'Best Quality', resolution: 'Best', container: 'mp4', quality: 'best' },
  { id: '4k', name: '4K Ultra HD', resolution: '2160p', container: 'mp4', quality: 'best' },
  { id: '1080p', name: 'Full HD', resolution: '1080p', container: 'mp4', quality: 'high' },
  { id: '720p', name: 'HD Ready', resolution: '720p', container: 'mp4', quality: 'medium' },
  { id: 'compact', name: 'Compact', resolution: '480p', container: 'mp4', quality: 'low' },
];
