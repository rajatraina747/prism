import type { MediaMetadata, FormatOption, DownloadItem, HistoryItem, AppPreferences, DiagnosticsEntry } from '@/types/models';

export function generateId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2, 11);
}

// ── Mock Video Titles & Data ──
const MOCK_TITLES = [
  'Advanced TypeScript Patterns for Production Apps',
  'Building Resilient Distributed Systems',
  'The Art of Modern UI Design',
  'Deep Dive into WebAssembly Performance',
  'Kubernetes at Scale: Lessons Learned',
  'React Server Components Explained',
  'Designing for Accessibility First',
  'Machine Learning in the Browser',
];

const MOCK_UPLOADERS = [
  'TechConf 2025', 'DevMaster Pro', 'CodeCraft Studios',
  'Engineering Daily', 'DesignLab Official', 'ByteSize Learning',
];

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateFormats(): FormatOption[] {
  return [
    { id: 'f-2160', label: '4K Ultra HD', resolution: '2160p', container: 'mp4', codec: 'H.265', fileSize: 2_400_000_000, quality: 'best' },
    { id: 'f-1080', label: 'Full HD', resolution: '1080p', container: 'mp4', codec: 'H.264', fileSize: 850_000_000, quality: 'high' },
    { id: 'f-720', label: 'HD', resolution: '720p', container: 'mp4', codec: 'H.264', fileSize: 420_000_000, quality: 'medium' },
    { id: 'f-480', label: 'SD', resolution: '480p', container: 'mp4', codec: 'H.264', fileSize: 180_000_000, quality: 'low' },
    { id: 'f-1080w', label: 'Full HD (WebM)', resolution: '1080p', container: 'webm', codec: 'VP9', fileSize: 780_000_000, quality: 'high' },
  ];
}

// ── Mock Parser ──
export async function mockParseUrl(url: string): Promise<MediaMetadata> {
  await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));

  if (!url || url.length < 5) {
    throw new Error('Invalid URL format. Please enter a valid video URL.');
  }

  let domain = 'unknown';
  try {
    domain = new URL(url).hostname.replace('www.', '');
  } catch {
    domain = url.split('/')[0] || 'unknown';
  }

  const title = randomFrom(MOCK_TITLES);
  const duration = 300 + Math.floor(Math.random() * 3600);

  return {
    title,
    duration,
    thumbnail: `https://picsum.photos/seed/${generateId()}/640/360`,
    source: { url, domain, addedAt: new Date().toISOString() },
    formats: generateFormats(),
    uploader: randomFrom(MOCK_UPLOADERS),
    description: `A comprehensive exploration of ${title.toLowerCase()}, covering key concepts and practical applications.`,
  };
}

// ── Mock Downloader ──
export type ProgressCallback = (data: {
  downloadedBytes: number;
  totalBytes: number;
  progress: number;
  speed: number;
  eta: number;
}) => void;

export type CompletionCallback = (success: boolean, error?: string) => void;

export function mockStartDownload(
  item: DownloadItem,
  onProgress: ProgressCallback,
  onComplete: CompletionCallback,
): () => void {
  let downloaded = item.downloadedBytes || 0;
  const total = item.totalBytes || 500_000_000;
  const failChance = 0.08;

  const interval = setInterval(() => {
    const chunk = (Math.random() * 3_000_000 + 800_000);
    downloaded = Math.min(downloaded + chunk, total);
    const progress = (downloaded / total) * 100;
    const speed = chunk * 5;
    const eta = speed > 0 ? (total - downloaded) / speed : 0;

    onProgress({ downloadedBytes: downloaded, totalBytes: total, progress, speed, eta });

    if (downloaded >= total) {
      clearInterval(interval);
      if (Math.random() < failChance) {
        onComplete(false, 'Connection interrupted during final transfer');
      } else {
        onComplete(true);
      }
    }
  }, 180);

  return () => clearInterval(interval);
}

// ── Persistence ──
const STORAGE_KEYS = {
  queue: 'prism_queue',
  history: 'prism_history',
  settings: 'prism_settings',
  diagnostics: 'prism_diagnostics',
} as const;

export const persistence = {
  loadQueue(): DownloadItem[] {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.queue);
      if (!data) return [];
      const items: DownloadItem[] = JSON.parse(data);
      return items.map(i => ({
        ...i,
        status: i.status === 'downloading' ? 'queued' as const : i.status,
        speed: 0,
        eta: 0,
      }));
    } catch { return []; }
  },
  saveQueue(items: DownloadItem[]) {
    try { localStorage.setItem(STORAGE_KEYS.queue, JSON.stringify(items)); } catch {}
  },
  loadHistory(): HistoryItem[] {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.history);
      return data ? JSON.parse(data) : [];
    } catch { return []; }
  },
  saveHistory(items: HistoryItem[]) {
    try { localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(items)); } catch {}
  },
  loadSettings(): AppPreferences | null {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.settings);
      return data ? JSON.parse(data) : null;
    } catch { return null; }
  },
  saveSettings(prefs: AppPreferences) {
    try { localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(prefs)); } catch {}
  },
};

// ── Diagnostics ──
const logs: DiagnosticsEntry[] = [];

export const diagnostics = {
  log(level: DiagnosticsEntry['level'], message: string, context?: Record<string, unknown>) {
    const entry: DiagnosticsEntry = { id: generateId(), level, message, timestamp: new Date().toISOString(), context };
    logs.push(entry);
    if (logs.length > 500) logs.shift();
    if (level === 'error') console.error(`[Prism] ${message}`, context);
  },
  getLogs(): DiagnosticsEntry[] { return [...logs]; },
  clear() { logs.length = 0; },
};

// ── Utilities ──
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i > 1 ? 1 : 0)} ${sizes[i]}`;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds: number): string {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return '--';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)}m`;
}
