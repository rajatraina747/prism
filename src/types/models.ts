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
  retryCount: number;
  startImmediately: boolean;
  audioOnly?: boolean;
  downloadSubtitles?: boolean;
  subtitleLanguage?: string;
  speedLimit?: number; // bytes per second, 0 = unlimited
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
  error?: DownloadError;
  retryAttempt: number;
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
};

export const DEFAULT_PRESETS: DownloadPreset[] = [
  { id: 'best', name: 'Best Quality', resolution: 'Best', container: 'mp4', quality: 'best' },
  { id: '4k', name: '4K Ultra HD', resolution: '2160p', container: 'mp4', quality: 'best' },
  { id: '1080p', name: 'Full HD', resolution: '1080p', container: 'mp4', quality: 'high' },
  { id: '720p', name: 'HD Ready', resolution: '720p', container: 'mp4', quality: 'medium' },
  { id: 'compact', name: 'Compact', resolution: '480p', container: 'mp4', quality: 'low' },
];
