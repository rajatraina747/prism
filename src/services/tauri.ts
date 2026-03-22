import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as dialogOpen, save as dialogSave } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile, mkdir, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

import type { MediaMetadata, DownloadItem, HistoryItem, AppPreferences, DiagnosticsEntry } from '@/types/models';
import type { IPrismService, ProgressCallback, CompletionCallback, UpdateCheckResult } from './types';

// Persistence file names (stored in app data directory)
const FILES = {
  queue: 'queue.json',
  history: 'history.json',
  settings: 'settings.json',
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

export class TauriPrismService implements IPrismService {
  async parseUrl(url: string): Promise<MediaMetadata> {
    return invoke<MediaMetadata>('parse_url', { url });
  }

  startDownload(
    item: DownloadItem,
    onProgress: ProgressCallback,
    onComplete: CompletionCallback,
  ): () => void {
    let progressUnlisten: UnlistenFn | null = null;
    let completeUnlisten: UnlistenFn | null = null;
    let cancelled = false;

    const setup = async () => {
      progressUnlisten = await listen<{
        id: string;
        downloaded_bytes: number;
        total_bytes: number;
        progress: number;
        speed: number;
        eta: number;
      }>(`download-progress-${item.id}`, (event) => {
        if (cancelled) return;
        onProgress({
          downloadedBytes: event.payload.downloaded_bytes,
          totalBytes: event.payload.total_bytes,
          progress: event.payload.progress,
          speed: event.payload.speed,
          eta: event.payload.eta,
        });
      });

      completeUnlisten = await listen<{
        id: string;
        success: boolean;
        error: string | null;
        file_path: string | null;
      }>(`download-complete-${item.id}`, (event) => {
        if (cancelled) return;
        cleanup();
        onComplete(event.payload.success, event.payload.error ?? undefined);
      });

      // Build output path (always .mp4 since we use --merge-output-format mp4)
      const dest = item.settings.destination || '~/Downloads/Prism';
      const filename = item.settings.filename || item.metadata.title || 'video';
      const outputPath = `${dest}/${filename}.mp4`;

      await invoke('start_download', {
        id: item.id,
        url: item.metadata.source.url,
        outputPath,
        formatId: item.settings.format?.id ?? null,
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
    await invoke('cancel_download', { id });
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
    // Will be implemented with tauri-plugin-updater in Phase 6
    return { available: false };
  }

  async getAppVersion(): Promise<string> {
    return invoke<string>('get_app_version');
  }

  persistence = {
    // These must be synchronous per the interface, so we use a cached approach.
    // On init we load from disk; writes go to both cache and disk.
    _queueCache: [] as DownloadItem[],
    _historyCache: [] as HistoryItem[],
    _settingsCache: null as AppPreferences | null,
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
    },

    loadQueue(): DownloadItem[] {
      // Kick off async load (will be ready on next call)
      this._ensureLoaded();
      return this._queueCache;
    },

    saveQueue(items: DownloadItem[]) {
      this._queueCache = items;
      writeJson(FILES.queue, items).catch(() => {});
    },

    loadHistory(): HistoryItem[] {
      this._ensureLoaded();
      return this._historyCache;
    },

    saveHistory(items: HistoryItem[]) {
      this._historyCache = items;
      writeJson(FILES.history, items).catch(() => {});
    },

    loadSettings(): AppPreferences | null {
      this._ensureLoaded();
      return this._settingsCache;
    },

    saveSettings(prefs: AppPreferences) {
      this._settingsCache = prefs;
      writeJson(FILES.settings, prefs).catch(() => {});
    },
  };
}
