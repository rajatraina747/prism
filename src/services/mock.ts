import type { MediaMetadata, FormatOption, DownloadItem, HistoryItem, AppPreferences, PlaylistInfo, Subscription, TorrentFileEntry } from '@/types/models';
import type { IPrismService, ProgressCallback, CompletionCallback } from './types';
import { generateId } from './utils';

// ── Mock Data ──

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

// ── localStorage Keys ──

const STORAGE_KEYS = {
  queue: 'prism_queue',
  history: 'prism_history',
  settings: 'prism_settings',
  subscriptions: 'prism_subscriptions',
} as const;

// ── Mock Service Implementation ──

export class MockPrismService implements IPrismService {
  async parsePlaylist(url: string, limit?: number): Promise<PlaylistInfo> {
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
    let count = 3 + Math.floor(Math.random() * 8);
    if (limit && limit > 0) count = Math.min(count, limit);
    const entries = Array.from({ length: count }, (_, i) => ({
      url: `${url}?v=mock${i}`,
      title: `${randomFrom(MOCK_TITLES)} (Part ${i + 1})`,
      duration: 120 + Math.floor(Math.random() * 3600),
      thumbnail: `https://picsum.photos/seed/${generateId()}/320/180`,
    }));
    return { title: `Mock Playlist (${count} videos)`, entries };
  }

  async parseTorrent(_magnet: string, _dest: string): Promise<TorrentFileEntry[]> {
    await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
    const GB = 1024 * 1024 * 1024;
    return [
      { index: 0, name: 'Ubuntu 24.04/ubuntu-24.04-desktop-amd64.iso', size: 5.9 * GB },
      { index: 1, name: 'Ubuntu 24.04/SHA256SUMS', size: 512 },
      { index: 2, name: 'Ubuntu 24.04/SHA256SUMS.gpg', size: 833 },
      { index: 3, name: 'Ubuntu 24.04/README.txt', size: 3421 },
    ];
  }

  async parseUrl(url: string): Promise<MediaMetadata> {
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

  startDownload(
    item: DownloadItem,
    onProgress: ProgressCallback,
    onComplete: CompletionCallback,
  ): () => void {
    const isTorrent = item.kind === 'torrent';
    let downloaded = item.downloadedBytes || 0;
    const total = item.totalBytes || 500_000_000;
    const failChance = isTorrent ? 0 : 0.08; // torrents self-heal via peers
    let seedTicks = 0; // once finished, a torrent seeds briefly before completing

    const interval = setInterval(() => {
      const chunk = Math.random() * 3_000_000 + 800_000;
      downloaded = Math.min(downloaded + chunk, total);
      const progress = (downloaded / total) * 100;
      const speed = chunk * 5;
      const eta = speed > 0 ? (total - downloaded) / speed : 0;
      const pct = (downloaded / total) * 100;
      const swarm = isTorrent
        ? {
            uploadSpeed: chunk * 1.5,
            peers: 8 + Math.floor(Math.random() * 20),
            seeds: 3 + Math.floor(Math.random() * 10),
            ratio: downloaded > 0 ? (downloaded * 0.2) / total : 0,
            // Simulated multi-file breakdown: the first file fills before the second.
            files: [
              { name: `${item.metadata.title}/disc1.iso`, size: total * 0.7, progress: Math.min(100, pct / 0.7) },
              { name: `${item.metadata.title}/README.txt`, size: total * 0.3, progress: Math.max(0, (pct - 70) / 0.3) },
            ],
          }
        : {};

      if (downloaded < total) {
        onProgress({ downloadedBytes: downloaded, totalBytes: total, progress, speed, eta, ...swarm });
        return;
      }

      if (isTorrent && seedTicks < 3) {
        // Seeding phase: full progress, uploading only.
        seedTicks += 1;
        onProgress({
          downloadedBytes: total,
          totalBytes: total,
          progress: 100,
          speed: 0,
          eta: 0,
          ...swarm,
          seeding: true,
        });
        return;
      }

      clearInterval(interval);
      if (Math.random() < failChance) {
        onComplete(false, 'Connection interrupted during final transfer');
      } else {
        onComplete(true);
      }
    }, 180);

    return () => clearInterval(interval);
  }

  async pauseDownload(_id: string): Promise<void> {
    // Mock: no-op — pausing is handled by clearing the interval in AppProvider
  }

  async cancelDownload(_id: string): Promise<void> {
    // Mock: no-op — cancellation is handled by clearing the interval in AppProvider
  }

  async setTorrentRateLimit(_bytesPerSec: number | null): Promise<void> {
    // Mock: no torrent engine to throttle
  }

  async openFile(filePath: string): Promise<void> {
    console.log('[Mock] Open file:', filePath);
  }

  async showInFolder(filePath: string): Promise<void> {
    console.log('[Mock] Show in folder:', filePath);
  }

  async pickDirectory(): Promise<string | null> {
    return prompt('Enter download path:') || null;
  }

  async getDefaultDownloadPath(): Promise<string> {
    return '~/Downloads/Prism';
  }

  async copyToClipboard(text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
  }

  async readClipboard(): Promise<string> {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return '';
    }
  }

  onDeepLink(_handler: (url: string) => void): () => void {
    // Deep links only exist in the desktop app
    return () => {};
  }

  async exportLogs(logs: import('@/types/models').DiagnosticsEntry[]): Promise<void> {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'prism-logs.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async checkForUpdates() {
    return { available: false } as import('./types').UpdateCheckResult;
  }

  async installUpdate(): Promise<void> {
    // Mock: no-op
  }

  async getAppVersion(): Promise<string> {
    return '1.0.0-web';
  }

  async getEngineVersion(): Promise<string> {
    return '2026.01.01-mock';
  }

  async updateEngine(): Promise<string> {
    await new Promise(r => setTimeout(r, 500));
    return '2026.01.01-mock';
  }

  async resetEngine(): Promise<void> {
    // Mock: no-op
  }

  persistence = {
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
    loadSubscriptions(): Subscription[] {
      try {
        const data = localStorage.getItem(STORAGE_KEYS.subscriptions);
        return data ? JSON.parse(data) : [];
      } catch { return []; }
    },
    saveSubscriptions(subs: Subscription[]) {
      try { localStorage.setItem(STORAGE_KEYS.subscriptions, JSON.stringify(subs)); } catch {}
    },
  };
}
