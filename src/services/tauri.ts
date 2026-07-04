import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as dialogOpen, save as dialogSave } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile, mkdir, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager';
import { check as checkUpdate, type Update } from '@tauri-apps/plugin-updater';
import { onOpenUrl, getCurrent as getCurrentDeepLinks } from '@tauri-apps/plugin-deep-link';
import { relaunch } from '@tauri-apps/plugin-process';

import type { MediaMetadata, DownloadItem, HistoryItem, AppPreferences, DiagnosticsEntry, PlaylistInfo, Subscription, TorrentFileEntry } from '@/types/models';
import type { IPrismService, ProgressCallback, CompletionCallback, UpdateCheckResult } from './types';
import { sanitizeFilename } from './utils';

// Persistence file names (stored in app data directory)
const FILES = {
  queue: 'queue.json',
  history: 'history.json',
  settings: 'settings.json',
  subscriptions: 'subscriptions.json',
} as const;

async function ensureAppData() {
  const dir = await exists('', { baseDir: BaseDirectory.AppData }).catch(() => false);
  if (!dir) {
    await mkdir('', { baseDir: BaseDirectory.AppData, recursive: true }).catch(() => {});
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const text = await readTextFile(file, { baseDir: BaseDirectory.AppData });
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureAppData();
  await writeTextFile(file, JSON.stringify(data), { baseDir: BaseDirectory.AppData });
}

/** Extract the video URL from a `prism://add?url=...` deep link. */
function parsePrismDeepLink(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'prism:') return null;
    // Accept both prism://add?url=... (host) and prism:/add?url=... (path)
    const action = u.hostname || u.pathname.replace(/^\/+/, '');
    if (action !== 'add') return null;
    const target = u.searchParams.get('url');
    if (!target) return null;
    const t = new URL(target);
    return (t.protocol === 'http:' || t.protocol === 'https:') ? target : null;
  } catch {
    return null;
  }
}

export class TauriPrismService implements IPrismService {
  private _initDone = false;
  private _pendingUpdate: Update | null = null;

  async init(): Promise<void> {
    await this.persistence._ensureLoaded();
    this._initDone = true;
  }

  async parseUrl(url: string): Promise<MediaMetadata> {
    return invoke<MediaMetadata>('parse_url', { url });
  }

  async parsePlaylist(url: string, limit?: number): Promise<PlaylistInfo> {
    return invoke<PlaylistInfo>('parse_playlist', { url, limit: limit ?? null });
  }

  async parseTorrent(magnet: string, dest: string): Promise<TorrentFileEntry[]> {
    return invoke<TorrentFileEntry[]>('parse_torrent', { magnet, outputPath: dest });
  }

  startDownload(
    item: DownloadItem,
    onProgress: ProgressCallback,
    onComplete: CompletionCallback,
  ): () => void {
    let progressUnlisten: UnlistenFn | null = null;
    let completeUnlisten: UnlistenFn | null = null;
    let cancelled = false;

    const isTorrent = item.kind === 'torrent';

    const setup = async () => {
      // The torrent engine emits the same event with extra swarm fields; HTTP
      // downloads simply leave them undefined.
      progressUnlisten = await listen<{
        id: string;
        downloaded_bytes: number;
        total_bytes: number;
        progress: number;
        speed: number;
        eta: number;
        upload_speed?: number;
        peers?: number;
        seeds?: number;
        ratio?: number;
        seeding?: boolean;
        files?: { name: string; size: number; progress: number }[];
      }>(`download-progress-${item.id}`, (event) => {
        if (cancelled) return;
        onProgress({
          downloadedBytes: event.payload.downloaded_bytes,
          totalBytes: event.payload.total_bytes,
          progress: event.payload.progress,
          speed: event.payload.speed,
          eta: event.payload.eta,
          uploadSpeed: event.payload.upload_speed,
          peers: event.payload.peers,
          seeds: event.payload.seeds,
          ratio: event.payload.ratio,
          seeding: event.payload.seeding,
          files: event.payload.files,
        });
      });

      completeUnlisten = await listen<{
        id: string;
        success: boolean;
        error: string | null;
        file_path: string | null;
        file_size: number | null;
      }>(`download-complete-${item.id}`, (event) => {
        if (cancelled) return;
        cleanup();
        onComplete(event.payload.success, event.payload.error ?? undefined, event.payload.file_path ?? undefined, event.payload.file_size ?? undefined);
      });

      const dest = item.settings.destination || '~/Downloads/Prism';

      if (isTorrent) {
        // Torrents download into the destination *directory*; librqbit names the
        // files from the torrent metadata. The magnet/.torrent URL is the source.
        await invoke('start_torrent', {
          id: item.id,
          magnet: item.metadata.source.url,
          outputPath: dest,
          onlyFiles: item.settings.selectedFiles ?? null,
        });
        return;
      }

      // Use %(ext)s template so yt-dlp can download video+audio separately
      // then merge them. --merge-output-format mp4 ensures final output is .mp4
      const filename = sanitizeFilename(item.settings.filename || item.metadata.title || 'video');
      const outputPath = `${dest}/${filename}.%(ext)s`;

      await invoke('start_download', {
        id: item.id,
        url: item.metadata.source.url,
        outputPath,
        formatId: item.settings.audioOnly ? null : (item.settings.format?.id ?? null),
        audioOnly: item.settings.audioOnly ?? false,
        downloadSubtitles: item.settings.downloadSubtitles ?? false,
        subtitleLanguage: item.settings.subtitleLanguage ?? null,
        speedLimit: item.settings.speedLimit ? item.settings.speedLimit : null,
        expectedSize: item.settings.format?.fileSize || null,
      });
    };

    const cleanup = () => {
      progressUnlisten?.();
      completeUnlisten?.();
      progressUnlisten = null;
      completeUnlisten = null;
    };

    setup().catch((err) => {
      cleanup();
      onComplete(false, String(err));
    });

    // Return cancel function
    return () => {
      cancelled = true;
      cleanup();
    };
  }

  async pauseDownload(_id: string): Promise<void> {
    // yt-dlp doesn't support true pause; cancel and track bytes for resume
    await this.cancelDownload(_id);
  }

  async cancelDownload(id: string): Promise<void> {
    // The caller doesn't track which engine owns the id, so signal both. Each is
    // a no-op for an id it doesn't own (yt-dlp child kill / librqbit session drop).
    await Promise.all([
      invoke('cancel_download', { id }).catch(() => {}),
      invoke('cancel_torrent', { id }).catch(() => {}),
    ]);
  }

  async setTorrentRateLimit(bytesPerSec: number | null): Promise<void> {
    await invoke('set_torrent_rate_limit', { bytesPerSec: bytesPerSec ?? null });
  }

  async openFile(filePath: string): Promise<void> {
    await invoke('open_file', { path: filePath });
  }

  async showInFolder(filePath: string): Promise<void> {
    await invoke('show_in_folder', { path: filePath });
  }

  async pickDirectory(): Promise<string | null> {
    const selected = await dialogOpen({ directory: true, multiple: false });
    return selected as string | null;
  }

  async getDefaultDownloadPath(): Promise<string> {
    return invoke<string>('get_default_download_path');
  }

  async copyToClipboard(text: string): Promise<void> {
    await writeText(text);
  }

  async readClipboard(): Promise<string> {
    return (await readText()) ?? '';
  }

  onDeepLink(handler: (url: string) => void): () => void {
    let unlisten: UnlistenFn | null = null;
    let trayUnlisten: UnlistenFn | null = null;
    let cancelled = false;

    const extract = (urls: string[]) => {
      if (cancelled) return;
      for (const raw of urls) {
        const url = parsePrismDeepLink(raw);
        if (url) handler(url);
      }
    };

    // Link that launched the app (cold start)
    getCurrentDeepLinks().then(urls => { if (urls) extract(urls); }).catch(() => {});
    // Links arriving while running
    onOpenUrl(extract).then(fn => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch(() => {});

    // Tray "Paste & Download" — the Rust side already validated http(s),
    // but re-check here since any window code could emit this event name.
    listen<string>('quick-add-url', (event) => {
      if (cancelled) return;
      try {
        const u = new URL(event.payload);
        if (u.protocol === 'http:' || u.protocol === 'https:') handler(event.payload);
      } catch { /* not a URL — ignore */ }
    }).then(fn => {
      if (cancelled) fn();
      else trayUnlisten = fn;
    }).catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
      unlisten = null;
      trayUnlisten?.();
      trayUnlisten = null;
    };
  }

  async exportLogs(logs: DiagnosticsEntry[]): Promise<void> {
    const path = await dialogSave({
      defaultPath: 'prism-logs.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (path) {
      await writeTextFile(path, JSON.stringify(logs, null, 2));
    }
  }

  async checkForUpdates(): Promise<UpdateCheckResult> {
    // Retry up to 2 times — GitHub CDN redirects can be slow/flaky
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const update = await checkUpdate({ timeout: 30_000 });
        if (update) {
          this._pendingUpdate = update;
          return { available: true, version: update.version, notes: update.body ?? undefined };
        }
        this._pendingUpdate = null;
        return { available: false };
      } catch (e) {
        if (attempt === 1) {
          this._pendingUpdate = null;
          const msg = e instanceof Error ? e.message : String(e);
          return { available: false, error: msg };
        }
        // Brief pause before retry
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    return { available: false, error: 'Check failed' };
  }

  async installUpdate(onProgress?: (downloaded: number, total: number | null) => void): Promise<void> {
    if (!this._pendingUpdate) {
      throw new Error('No update available to install');
    }
    let totalDownloaded = 0;
    await this._pendingUpdate.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        onProgress?.(0, event.data.contentLength ?? null);
      } else if (event.event === 'Progress') {
        totalDownloaded += event.data.chunkLength;
        onProgress?.(totalDownloaded, null);
      }
    });
    // Explicitly relaunch — downloadAndInstall doesn't always restart on macOS
    await relaunch();
  }

  async getAppVersion(): Promise<string> {
    return invoke<string>('get_app_version');
  }

  async getEngineVersion(): Promise<string> {
    return invoke<string>('get_ytdlp_version');
  }

  async updateEngine(): Promise<string> {
    return invoke<string>('update_ytdlp');
  }

  async resetEngine(): Promise<void> {
    await invoke('reset_ytdlp');
  }

  persistence = {
    // Data is preloaded by init() before the UI renders.
    // Writes go to both the in-memory cache and disk.
    _queueCache: [] as DownloadItem[],
    _historyCache: [] as HistoryItem[],
    _settingsCache: null as AppPreferences | null,
    _subscriptionsCache: [] as Subscription[],
    _loaded: false,

    async _ensureLoaded() {
      if (this._loaded) return;
      this._loaded = true;
      this._queueCache = await readJson<DownloadItem[]>(FILES.queue, []);
      this._queueCache = this._queueCache.map(i => ({
        ...i,
        status: i.status === 'downloading' ? 'queued' as const : i.status,
        speed: 0,
        eta: 0,
      }));
      this._historyCache = await readJson<HistoryItem[]>(FILES.history, []);
      this._settingsCache = await readJson<AppPreferences | null>(FILES.settings, null);
      this._subscriptionsCache = await readJson<Subscription[]>(FILES.subscriptions, []);
    },

    loadQueue(): DownloadItem[] {
      return this._queueCache;
    },

    saveQueue: (items: DownloadItem[]) => {
      this.persistence._queueCache = items;
      if (this._initDone) writeJson(FILES.queue, items).catch(() => {});
    },

    loadHistory(): HistoryItem[] {
      return this._historyCache;
    },

    saveHistory: (items: HistoryItem[]) => {
      this.persistence._historyCache = items;
      if (this._initDone) writeJson(FILES.history, items).catch(() => {});
    },

    loadSettings(): AppPreferences | null {
      return this._settingsCache;
    },

    saveSettings: (prefs: AppPreferences) => {
      this.persistence._settingsCache = prefs;
      if (this._initDone) writeJson(FILES.settings, prefs).catch(() => {});
    },

    loadSubscriptions(): Subscription[] {
      return this._subscriptionsCache;
    },

    saveSubscriptions: (subs: Subscription[]) => {
      this.persistence._subscriptionsCache = subs;
      if (this._initDone) writeJson(FILES.subscriptions, subs).catch(() => {});
    },
  };
}
