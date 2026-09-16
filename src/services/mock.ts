import type { MediaMetadata, FormatOption, DownloadItem, HistoryItem, AppPreferences, PlaylistInfo, Subscription, TorrentFileEntry, TorrentPeer, TorrentDetails, SessionStats, WhenDoneAction, GlobalShortcuts, ShortcutAction } from '@/types/models';
import type { IPrismService, ProgressCallback, CompletionCallback, EngineInfo, LinkProbe, TemplateVars, StorageSummary } from './types';
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

/** A plausible have-pieces bar for `pct` percent complete: a filled head
 * plus scattered pieces further along, like a real swarm download. */
function mockPieces(pct: number): number[] {
  const buckets = 200;
  const head = Math.floor((pct / 100) * buckets);
  return Array.from({ length: buckets }, (_, i) => {
    if (i < head) return 255;
    if (i < head + 6) return Math.floor(255 * ((head + 6 - i) / 6));
    return (i * 7919) % 23 === 0 ? 80 + ((i * 31) % 120) : 0;
  });
}

// ── localStorage Keys ──

const STORAGE_KEYS = {
  queue: 'prism_queue',
  history: 'prism_history',
  settings: 'prism_settings',
  subscriptions: 'prism_subscriptions',
  stats: 'prism_stats',
} as const;

// ── Mock Service Implementation ──

export class MockPrismService implements IPrismService {
  readonly isDemo = true;
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
      const peers = 8 + Math.floor(Math.random() * 20);
      const swarm = isTorrent
        ? {
            uploadSpeed: chunk * 1.5,
            peers,
            peersSeen: peers + 12,
            peersConnecting: Math.floor(Math.random() * 3),
            ratio: downloaded > 0 ? (downloaded * 0.2) / total : 0,
            uploadedBytes: Math.floor(downloaded * 0.2),
            peerlessSecs: 0,
            // Simulated multi-file breakdown: the first file fills before the second.
            files: [
              { name: `${item.metadata.title}/disc1.iso`, size: total * 0.7, progress: Math.min(100, pct / 0.7) },
              { name: `${item.metadata.title}/README.txt`, size: total * 0.3, progress: Math.max(0, (pct - 70) / 0.3) },
            ],
            pieces: mockPieces(pct),
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

  async pauseTorrent(_id: string): Promise<void> {
    // Mock: no-op — the sim keeps ticking but the reducer ignores progress
    // while an item is paused, so the UI behaves the same.
  }

  async resumeTorrent(_id: string): Promise<void> {
    // Mock: no-op
  }

  async updateTorrentFiles(_id: string, _onlyFiles: number[]): Promise<void> {
    // Mock: no torrent engine
  }

  async setDirectRateLimit(_bytesPerSecond: number | null): Promise<void> {
    // Mock: nothing to throttle
  }

  async setTorrentRateLimits(_downloadBps: number | null, _uploadBps: number | null): Promise<void> {
    // Mock: no torrent engine to throttle
  }

  async reannounceTorrent(_id: string): Promise<void> {
    await new Promise(r => setTimeout(r, 300));
  }

  async recheckTorrent(_id: string): Promise<void> {
    await new Promise(r => setTimeout(r, 300));
  }

  async removeTorrentData(id: string): Promise<void> {
    console.log('[Mock] Remove torrent data:', id);
  }

  async getTorrentPeers(_id: string): Promise<TorrentPeer[]> {
    const clients = ['qBittorrent 5.0.4', 'Transmission 4.0.6', 'libtorrent 2.0.10', 'Deluge 2.1.1', 'rqbit 9.0.1', 'µTorrent 3.6'];
    const kinds = ['tcp', 'tcp', 'tcp', 'utp'];
    const n = 8 + Math.floor(Math.random() * 8);
    return Array.from({ length: n }, (_, i) => {
      const live = i < n - 2;
      return {
        addr: `${10 + i}.${(i * 37) % 255}.${(i * 91) % 255}.${(i * 13) % 255}:${6881 + (i % 9)}`,
        client: clients[i % clients.length],
        kind: kinds[i % kinds.length],
        state: live ? 'live' : 'connecting',
        downBps: live ? Math.random() * 900_000 : 0,
        upBps: live ? Math.random() * 120_000 : 0,
        downloaded: Math.floor(Math.random() * 400_000_000),
        uploaded: Math.floor(Math.random() * 40_000_000),
        errors: i % 5 === 0 ? 1 : 0,
      };
    });
  }

  async getTorrentDetails(id: string): Promise<TorrentDetails> {
    return {
      infoHash: `${id.replace(/[^a-f0-9]/gi, '').padEnd(40, '0').slice(0, 40)}`,
      name: 'Ubuntu 24.04',
      outputFolder: '~/Downloads/Prism',
      totalBytes: 5.9 * 1024 * 1024 * 1024,
      totalPieces: 1512,
      pieceLength: 4 * 1024 * 1024,
      private: false,
      trackers: ['udp://tracker.opentrackr.org:1337/announce', 'https://torrent.ubuntu.com/announce'],
      fileCount: 4,
      addedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      state: 'live',
    };
  }

  onSessionStats(handler: (stats: SessionStats) => void): () => void {
    const tick = () => handler({
      downloadBps: 2_000_000 + Math.random() * 3_000_000,
      uploadBps: 200_000 + Math.random() * 300_000,
      peersLive: 12 + Math.floor(Math.random() * 10),
      peersConnecting: Math.floor(Math.random() * 4),
      peersSeen: 60 + Math.floor(Math.random() * 20),
      dhtNodes: 280 + Math.floor(Math.random() * 40),
      listenPort: 4240,
      upnp: true,
      dht: true,
      utp: false,
      activeTorrents: 1,
    });
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }

  async openFile(filePath: string): Promise<void> {
    console.log('[Mock] Open file:', filePath);
  }

  async showInFolder(filePath: string): Promise<void> {
    console.log('[Mock] Show in folder:', filePath);
  }

  async openExternal(url: string): Promise<void> {
    // Web demo: a normal browser tab is exactly right here.
    window.open(url, '_blank', 'noopener,noreferrer');
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

  async notify(_title: string, _body: string): Promise<void> {
    // Web demo: in-app toasts cover it.
  }

  async whenDone(_action: WhenDoneAction): Promise<void> {
    // Web demo: there is no machine here to sleep or shut down.
  }

  onDeepLink(_handler: (url: string, origin: import('./types').LinkOrigin) => void): () => void {
    // Deep links only exist in the desktop app
    return () => {};
  }

  async importTorrentFile(name: string, bytes: Uint8Array): Promise<string> {
    // Demo: a stable fake info hash from the name and size; nothing is stored.
    let h = 2166136261;
    for (const c of `${name}:${bytes.length}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    const hash = h.toString(16).padStart(8, '0').repeat(5);
    return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name.replace(/\.torrent$/i, ''))}`;
  }

  async pickTorrentFile(): Promise<string | null> {
    // The browser demo has no native file paths to hand to a torrent engine.
    return null;
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

  async ffmpegAvailable(): Promise<boolean> {
    return true;
  }

  async moveToTrash(paths: string[]): Promise<number> {
    // Web demo: no files to move, so report what would have gone.
    return paths.length;
  }

  async setShortcuts(_shortcuts: GlobalShortcuts): Promise<void> {
    // Web demo: a page can't claim a system-wide hotkey, so this is a no-op
    // rather than a pretend success with a fake registration behind it.
  }

  onShortcut(_handler: (action: ShortcutAction) => void): () => void {
    return () => {};
  }

  async setProgress(_percent: number | null, _paused: boolean): Promise<void> {
    // Web demo: a page has no Dock or taskbar to draw on.
  }

  async fetchRss(url: string, limit?: number): Promise<PlaylistInfo> {
    await new Promise(r => setTimeout(r, 400));
    const host = (() => { try { return new URL(url).hostname; } catch { return 'example.com'; } })();
    const entries = Array.from({ length: Math.min(limit ?? 5, 5) }, (_, i) => ({
      url: `https://${host}/files/episode-${i + 1}.mp3`,
      title: `Episode ${i + 1}`,
      duration: 0,
      thumbnail: '',
    }));
    return { title: `${host} feed`, entries };
  }

  async storageSummary(folder: string): Promise<StorageSummary> {
    // Web demo: no disk to measure, so a plausible fixed answer rather than
    // zeroes, which would read as "nothing downloaded".
    return { folder, files: 12, bytes: 3_221_225_472, freeBytes: 128_849_018_880, partial: false };
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

  async getEngineInfo(): Promise<EngineInfo> {
    return {
      active: 'bundled',
      activeVersion: '2026.01.01-mock',
      bundledVersion: '2026.01.01-mock',
      managedVersion: null,
      latest: null,
      checkedAt: null,
      updateAvailable: false,
    };
  }

  async checkEngineUpdate(): Promise<EngineInfo> {
    // The demo never contacts GitHub.
    return this.getEngineInfo();
  }

  async probeDirectLink(url: string): Promise<LinkProbe> {
    const name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '') || 'download';
    return { finalUrl: url, filename: name, size: 250_000_000, acceptRanges: true, contentType: 'application/octet-stream' };
  }

  async previewFilenameTemplate(template: string, vars: TemplateVars): Promise<string> {
    // The demo's stand-in for template.rs: token replacement only (no date
    // formats, no validation).
    const values: Record<string, string | undefined> = { ...vars, name: vars.filename?.replace(/\.[^.]+$/, '') };
    const rendered = (template.trim() || '{title}')
      .replace(/\{(\w+)(?::[^}]*)?\}/g, (_match, key: string) => (values[key] ?? '').replace(/[/\\]/g, '-'));
    return rendered.split('/').map(part => part.trim()).filter(Boolean).join('/') || 'download';
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
    loadStats(): unknown {
      try {
        const data = localStorage.getItem(STORAGE_KEYS.stats);
        return data ? JSON.parse(data) : null;
      } catch { return null; }
    },
    saveStats(stats: unknown) {
      try { localStorage.setItem(STORAGE_KEYS.stats, JSON.stringify(stats)); } catch {}
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
