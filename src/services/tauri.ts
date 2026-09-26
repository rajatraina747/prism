import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { setThumbResolver } from '@/lib/thumb-cache';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { save as dialogSave, open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile, rename, BaseDirectory } from '@tauri-apps/plugin-fs';
import { loadJson, saveJson, type JsonFs } from '@/lib/json-store';
import { reportStoreProblem } from '@/lib/store-problems';
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager';
import { onOpenUrl, getCurrent as getCurrentDeepLinks } from '@tauri-apps/plugin-deep-link';
import { relaunch } from '@tauri-apps/plugin-process';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

import type { MediaMetadata, DownloadItem, HistoryItem, AppPreferences, DiagnosticsEntry, PlaylistInfo, InspectResult, Subscription, TorrentFileEntry, TorrentPeer, TorrentDetails, SessionStats, WhenDoneAction, GlobalShortcuts, ShortcutAction } from '@/types/models';
import type { IPrismService, ProgressCallback, CompletionCallback, UpdateCheckResult, LinkOrigin, EngineInfo, LinkProbe, TemplateVars, StorageSummary, ContentMatch, ConvertPreset } from './types';
import { applyFinished, type FinishedDownload } from '@/stores/finished';
import { sanitizeFilename, ytdlpLiteral, isTorrentUrl, parsePrismDeepLink } from './utils';
import { createWriteQueue } from '@/lib/write-queue';

// Persistence file names (stored in app data directory). The webview's fs
// capability covers exactly `$APPDATA/*.json` (+ `.json.tmp`), top level only —
// everything Rust owns under app data (torrent session, .torrent cache, the
// self-updated yt-dlp) is out of its reach. Rust creates the directory.
const FILES = {
  queue: 'queue.json',
  history: 'history.json',
  settings: 'settings.json',
  subscriptions: 'subscriptions.json',
  stats: 'stats.json',
} as const;

const appDataFs: JsonFs = {
  read: file => readTextFile(file, { baseDir: BaseDirectory.AppData }),
  write: (file, text) => writeTextFile(file, text, { baseDir: BaseDirectory.AppData }),
  rename: (from, to) => rename(from, to, {
    oldPathBaseDir: BaseDirectory.AppData,
    newPathBaseDir: BaseDirectory.AppData,
  }),
};

// A damaged file is set aside and its backup loaded, never silently replaced
// by the fallback (lib/json-store.ts).
function readJson<T>(file: string, fallback: T): Promise<T> {
  return loadJson(appDataFs, file, fallback, reportStoreProblem);
}

// Write-then-rename (keeping the previous copy as `.bak.json`) through a
// per-file queue, so two saves of one file never share the `.tmp` at once.
// A save that fails is reported rather than swallowed.
const writeJsonText = createWriteQueue(
  (file, text) => saveJson(appDataFs, file, text),
  file => reportStoreProblem({ kind: 'save-failed', file }),
);

async function writeJson(file: string, data: unknown): Promise<void> {
  // Serialised now, so what is saved is the data as it was at this call.
  await writeJsonText(file, JSON.stringify(data));
}

// The launch deep link belongs to the process, not to any one subscription:
// `getCurrent()` keeps returning it on Windows/Linux (it is parsed from argv at
// startup), so it is read once and handed to the first live subscriber.
let launchLinksPromise: Promise<string[]> | null = null;
let launchLinksDelivered = false;

function readLaunchLinks(): Promise<string[]> {
  // Scheme deep links (prism://, magnet:) come from the deep-link plugin;
  // `.torrent` files Prism was launched with arrive as plain argv on
  // Windows/Linux and are reported by the Rust side (validated there again
  // before the engine ever sees them).
  launchLinksPromise ??= Promise.all([
    getCurrentDeepLinks().then(urls => urls ?? []).catch(() => [] as string[]),
    (async () => {
      try {
        return (await invoke<string[]>('get_launch_torrent_files')) ?? [];
      } catch {
        return [] as string[];
      }
    })(),
  ]).then(([links, files]) => [...links, ...files]);
  return launchLinksPromise;
}

/** What a file name template can use for this item (template.rs). */
function templateVarsFor(item: DownloadItem): TemplateVars {
  return {
    // A name typed in the details dialog wins over the site's title. Stored
    // names are escaped for yt-dlp (% → %%); the template wants the raw text.
    title: (item.settings.filename || item.metadata.title || '').replace(/%%/g, '%'),
    uploader: item.metadata.uploader,
    site: item.metadata.source.domain,
    resolution: item.settings.format?.resolution,
    // Sites don't report an upload date here; {date} is the day it was added.
    date: item.metadata.source.addedAt,
  };
}

export class TauriPrismService implements IPrismService {
  private _initDone = false;

  async init(): Promise<void> {
    // Thumbnails from a local copy, fetched once through the proxy.
    setThumbResolver(async url => convertFileSrc(await invoke<string>('cache_thumbnail', { url })));
    await this.persistence._ensureLoaded();
    this._initDone = true;
  }

  async parseUrl(url: string): Promise<MediaMetadata> {
    return invoke<MediaMetadata>('parse_url', { url });
  }

  async inspectUrl(url: string): Promise<InspectResult> {
    return invoke<InspectResult>('inspect_url', { url });
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
        stage?: 'processing';
        upload_speed?: number;
        peers?: number;
        peers_seen?: number;
        peers_connecting?: number;
        ratio?: number;
        seeding?: boolean;
        files?: { name: string; size: number; progress: number }[];
        uploaded_bytes?: number;
        peerless_secs?: number;
        pieces?: number[];
      }>(`download-progress-${item.id}`, (event) => {
        if (cancelled) return;
        const p = event.payload;
        onProgress({
          downloadedBytes: p.downloaded_bytes,
          totalBytes: p.total_bytes,
          progress: p.progress,
          speed: p.speed,
          eta: p.eta,
          // Deliberately present even when undefined: clears a stale stage.
          stage: p.stage,
          uploadSpeed: p.upload_speed,
          peers: p.peers,
          peersSeen: p.peers_seen,
          peersConnecting: p.peers_connecting,
          ratio: p.ratio,
          seeding: p.seeding,
          uploadedBytes: p.uploaded_bytes,
          peerlessSecs: p.peerless_secs,
          // Only present on periodic ticks; omit the keys otherwise so the
          // reducer keeps the last file list / pieces map instead of clearing it.
          ...(p.files !== undefined ? { files: p.files } : {}),
          ...(p.pieces !== undefined ? { pieces: p.pieces } : {}),
        });
      });

      completeUnlisten = await listen<{
        id: string;
        success: boolean;
        error: import('@/services/errors').EngineError | string | null;
        file_path: string | null;
        file_size: number | null;
        actual_height?: number | null;
        output_folder?: string | null;
      }>(`download-complete-${item.id}`, (event) => {
        if (cancelled) return;
        cleanup();
        onComplete(
          event.payload.success,
          event.payload.error ?? undefined,
          event.payload.file_path ?? undefined,
          event.payload.file_size ?? undefined,
          event.payload.actual_height ?? undefined,
          event.payload.output_folder ?? undefined,
        );
      });

      // Stopped while the listeners were being set up: the cancel's cleanup
      // ran before they existed, so drop them now, and don't start at all
      // (REVIEW 2026-09-23 B-5). A stop after this point reaches the engine,
      // which checks for one before it registers the job.
      if (cancelled) {
        cleanup();
        return;
      }

      const dest = item.settings.destination || '~/Downloads/Prism';

      if (isTorrent) {
        // Torrents download into the destination *directory*; librqbit names the
        // files from the torrent metadata. The magnet/.torrent URL is the source.
        await invoke('start_torrent', {
          id: item.id,
          magnet: item.metadata.source.url,
          outputPath: dest,
          onlyFiles: item.settings.selectedFiles ?? null,
          // Per-item cap (quiet-hours override flows in via effectiveItem);
          // applies on top of the session-wide limit.
          speedLimit: item.settings.speedLimit ? item.settings.speedLimit : null,
        });
        return;
      }

      if (item.kind === 'convert') {
        // Not a download: the source is a file already on disk, named by the
        // item's source URL. It reports through the same events as everything
        // above, so the listeners set up here need no special case.
        await invoke('convert_file', {
          id: item.id,
          input: item.metadata.source.url,
          preset: item.settings.convertPreset ?? 'mp4-h264',
          durationSecs: item.metadata.duration || 0,
        });
        return;
      }

      if (item.kind === 'direct') {
        // The engine resumes an unfinished file of the same name in `dest`.
        await invoke('start_http_download', {
          id: item.id,
          url: item.metadata.source.url,
          outputDir: dest,
          filename: item.settings.filename || null,
          sha256: item.settings.sha256 ?? null,
          speedLimit: item.settings.speedLimit ? item.settings.speedLimit : null,
          filenameTemplate: item.settings.filenameTemplate ?? null,
          templateVars: templateVarsFor(item),
        });
        return;
      }

      // Use %(ext)s template so yt-dlp can download video+audio separately
      // then merge them. --merge-output-format mp4 ensures final output is .mp4
      const filename = sanitizeFilename(item.settings.filename || item.metadata.title || 'video');
      // `%` is literal in both, and yt-dlp would expand it: escape it here,
      // once (the name comes back from sanitizeFilename unescaped).
      const outputPath = `${ytdlpLiteral(dest)}/${ytdlpLiteral(filename)}.%(ext)s`;

      await invoke('start_download', {
        id: item.id,
        url: item.metadata.source.url,
        outputPath,
        formatId: item.settings.audioOnly ? null : (item.settings.format?.id ?? null),
        audioOnly: item.settings.audioOnly ?? false,
        downloadSubtitles: item.settings.downloadSubtitles ?? false,
        subtitleLanguage: item.settings.subtitleLanguage ?? null,
        audioLanguage: item.settings.audioLanguage ?? null,
        embedSubtitles: item.settings.embedSubtitles ?? false,
        useArchive: item.settings.useArchive ?? false,
        speedLimit: item.settings.speedLimit ? item.settings.speedLimit : null,
        expectedSize: item.settings.format?.fileSize || null,
        clipStart: item.settings.clipStart ?? null,
        clipEnd: item.settings.clipEnd ?? null,
        splitChapters: item.settings.splitChapters ?? false,
        useCookies: !item.settings.noCookies,
        // With a template, Rust builds the output path itself from these.
        outputDir: dest,
        filenameTemplate: item.settings.filenameTemplate ?? null,
        templateVars: templateVarsFor(item),
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
    // The caller doesn't track which engine owns the id, so signal all three.
    // Each is a no-op for an id it doesn't own.
    await Promise.all([
      invoke('cancel_download', { id }).catch(() => {}),
      invoke('cancel_torrent', { id }).catch(() => {}),
      invoke('cancel_http_download', { id }).catch(() => {}),
      // A conversion is spawned outside the three download engines, so it
      // needs signalling too — otherwise ffmpeg keeps running with nothing
      // in the UI left pointing at it.
      invoke('cancel_convert', { id }).catch(() => {}),
    ]);
  }

  async pauseTorrent(id: string): Promise<void> {
    await invoke('pause_torrent', { id });
  }

  async resumeTorrent(id: string): Promise<void> {
    await invoke('resume_torrent', { id });
  }

  async updateTorrentFiles(id: string, onlyFiles: number[]): Promise<void> {
    await invoke('update_torrent_files', { id, onlyFiles });
  }

  async setTorrentRateLimits(downloadBps: number | null, uploadBps: number | null): Promise<void> {
    await invoke('set_torrent_rate_limit', { downloadBps: downloadBps ?? null, uploadBps: uploadBps ?? null });
  }

  async setDirectRateLimit(bytesPerSecond: number | null): Promise<void> {
    await invoke('set_http_rate_limit', { bytesPerSecond: bytesPerSecond ?? 0 });
  }

  async reannounceTorrent(id: string): Promise<void> {
    await invoke('reannounce_torrent', { id });
  }

  async recheckTorrent(id: string): Promise<void> {
    await invoke('recheck_torrent', { id });
  }

  async removeTorrentData(id: string): Promise<void> {
    await invoke('cancel_torrent', { id, deleteFiles: true });
  }

  async getTorrentPeers(id: string): Promise<TorrentPeer[]> {
    return await invoke<TorrentPeer[]>('torrent_peers', { id });
  }

  async getTorrentDetails(id: string): Promise<TorrentDetails> {
    return await invoke<TorrentDetails>('torrent_details', { id });
  }

  onSessionStats(handler: (stats: SessionStats) => void): () => void {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<SessionStats>('torrent-session-stats', (e) => {
      if (!cancelled) handler(e.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
      unlisten = null;
    };
  }

  async openFile(filePath: string): Promise<void> {
    await invoke('open_file', { path: filePath });
  }

  async showInFolder(filePath: string): Promise<void> {
    await invoke('show_in_folder', { path: filePath });
  }

  async openExternal(url: string): Promise<void> {
    await invoke('open_external', { url });
  }

  async pickDirectory(): Promise<string | null> {
    // The picker runs in Rust so the user's choice itself becomes an allowed
    // download root (external drives, NAS) — see `pick_download_dir`.
    return await invoke<string | null>('pick_download_dir');
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

  async whenDone(action: WhenDoneAction): Promise<void> {
    // Rust refuses anything but a known action; the string never reaches a shell.
    await invoke('when_done', { action });
  }

  async notify(title: string, body: string): Promise<void> {
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        granted = (await requestPermission()) === 'granted';
      }
      if (granted) sendNotification({ title, body });
    } catch { /* notifications unavailable — in-app toast already covers it */ }
  }

  onDeepLink(handler: (url: string, origin: LinkOrigin) => void): () => void {
    let unlisten: UnlistenFn | null = null;
    let trayUnlisten: UnlistenFn | null = null;
    let fileUnlisten: UnlistenFn | null = null;
    let watchUnlisten: UnlistenFn | null = null;
    let cancelled = false;

    // Everything the OS delivers is `external`: a web page can open magnet:
    // and prism:// links without the user meaning to, so the Dashboard asks
    // before parsing (which already reaches the network).
    const extract = (urls: string[]) => {
      if (cancelled) return;
      for (const raw of urls) {
        const trimmed = raw.trim();
        // Magnet links / .torrent files go to the torrent add flow. Everything
        // else must be a prism://add?url=... deep link.
        if (isTorrentUrl(trimmed)) {
          handler(trimmed, 'external');
          continue;
        }
        const url = parsePrismDeepLink(raw);
        if (url) handler(url, 'external');
      }
    };

    // Link that launched the app (cold start). On Windows/Linux the plugin
    // keeps this value for the whole process lifetime, so a second read
    // replays the launch link — deliver it exactly once. (Not marked delivered
    // if this subscription was torn down first, so a remount still gets it.)
    if (!launchLinksDelivered) {
      readLaunchLinks().then(urls => {
        if (cancelled || launchLinksDelivered) return;
        launchLinksDelivered = true;
        extract(urls);
      });
    }
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
        // The user clicked the tray item — in-app intent, no confirmation.
        if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'magnet:') handler(event.payload, 'app');
      } catch { /* not a URL — ignore */ }
    }).then(fn => {
      if (cancelled) fn();
      else trayUnlisten = fn;
    }).catch(() => {});

    // A .torrent opened while Prism is running (Windows/Linux second-instance
    // argv, forwarded by the Rust single-instance handler). Same add flow as a
    // magnet: file picker + confirmation; Rust re-validates the path.
    listen<string>('open-torrent-file', (event) => {
      if (cancelled) return;
      if (isTorrentUrl(event.payload)) handler(event.payload.trim(), 'external');
    }).then(fn => {
      if (cancelled) fn();
      else fileUnlisten = fn;
    }).catch(() => {});

    // Found in a watch folder the user configured. Always the confirmation
    // card: anything can put a .txt or a .torrent in a watched Downloads
    // folder, a web page included (REVIEW 2026-09-23 S-1, 2026-09-26 H2).
    // Rust marks every link `confirm: true`; the flag is not trusted here.
    listen<{ url: string; confirm: boolean }[]>('watch-folder-links', (event) => {
      if (cancelled) return;
      for (const link of event.payload ?? []) {
        const trimmed = typeof link?.url === 'string' ? link.url.trim() : '';
        if (trimmed) handler(trimmed, 'external');
      }
    }).then(fn => {
      if (cancelled) fn();
      else watchUnlisten = fn;
    }).catch(() => {});

    return () => {
      cancelled = true;
      watchUnlisten?.();
      watchUnlisten = null;
      fileUnlisten?.();
      fileUnlisten = null;
      unlisten?.();
      unlisten = null;
      trayUnlisten?.();
      trayUnlisten = null;
    };
  }

  async importTorrentFile(name: string, bytes: Uint8Array): Promise<string> {
    // Raw bytes as the request body, not a JSON array of numbers (about 4×
    // the size on the wire); the name is a percent-encoded header.
    return invoke<string>('import_torrent_file', bytes, {
      headers: { 'x-prism-torrent-name': encodeURIComponent(name) },
    });
  }

  async pickTorrentFile(): Promise<string | null> {
    // The path goes through the normal add flow; Rust validates it again.
    const picked = await dialogOpen({
      multiple: false,
      directory: false,
      filters: [{ name: 'Torrent', extensions: ['torrent'] }],
    });
    return typeof picked === 'string' ? picked : null;
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

  async saveBackup(json: string, suggestedName: string): Promise<boolean> {
    const path = await dialogSave({
      defaultPath: suggestedName,
      filters: [{ name: 'Prism backup', extensions: ['json'] }],
    });
    if (!path) return false;
    await writeTextFile(path, json);
    return true;
  }

  async importTorrentClient(client: 'qbittorrent' | 'transmission') {
    return invoke<{ torrents: { magnet: string; savePath: string | null }[]; skipped: number } | null>('import_torrent_client', { client });
  }

  async openBackup(): Promise<string | null> {
    // Rust shows the dialog and reads the file: the main window's fs access
    // is limited to Prism's own data files, and stays that way.
    return invoke<string | null>('open_backup_file');
  }

  async ffmpegAvailable(): Promise<boolean> {
    return invoke<boolean>('ffmpeg_available').catch(() => true);
  }

  async storageSummary(folder: string): Promise<StorageSummary> {
    return invoke<StorageSummary>('storage_summary', { folder });
  }

  async moveToTrash(paths: string[]): Promise<number> {
    return invoke<number>('move_to_trash', { paths });
  }

  async fetchRss(url: string, limit?: number): Promise<PlaylistInfo> {
    return invoke<PlaylistInfo>('rss_fetch', { url, limit });
  }

  async setShortcuts(shortcuts: GlobalShortcuts): Promise<void> {
    return invoke('set_shortcuts', { shortcuts });
  }

  async setProgress(percent: number | null, paused: boolean): Promise<void> {
    return invoke('set_progress', { percent, paused });
  }

  async indexDownload(path: string, title: string): Promise<ContentMatch | null> {
    return invoke<ContentMatch | null>('index_download', { path, title });
  }

  async convertFile(id: string, input: string, preset: ConvertPreset, durationSecs: number): Promise<void> {
    return invoke('convert_file', { id, input, preset, durationSecs });
  }

  onMenuAction(handler: (action: string) => void): () => void {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<string>('menu-action', e => handler(e.payload)).then(fn => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => { cancelled = true; unlisten?.(); };
  }

  onShortcut(handler: (action: ShortcutAction) => void): () => void {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<ShortcutAction>('shortcut-action', e => handler(e.payload)).then(fn => {
      // Unsubscribed before the listener finished attaching.
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => { cancelled = true; unlisten?.(); };
  }

  async checkForUpdates(): Promise<UpdateCheckResult> {
    // The check runs in Rust (`check_app_update`) so its HTTP client can carry
    // a connect timeout — see src-tauri/src/updater.rs. One retry for a
    // transient failure; the error text is the real cause, not a generic line.
    let lastError = 'Check failed';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const info = await invoke<{ available: boolean; version: string | null; notes: string | null }>('check_app_update');
        return info.available
          ? { available: true, version: info.version ?? undefined, notes: info.notes ?? undefined }
          : { available: false };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
      }
    }
    return { available: false, error: lastError };
  }

  async installUpdate(onProgress?: (downloaded: number, total: number | null) => void): Promise<void> {
    const unlisten = await listen<{ downloaded: number; total: number | null }>('app-update-progress', (e) => {
      onProgress?.(e.payload.downloaded, e.payload.total);
    });
    try {
      await invoke('install_app_update');
    } finally {
      unlisten();
    }
    // Explicitly relaunch — installing doesn't always restart on macOS
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

  async getEngineInfo(): Promise<EngineInfo> {
    return invoke<EngineInfo>('get_engine_info');
  }

  async checkEngineUpdate(force = false): Promise<EngineInfo> {
    return invoke<EngineInfo>('check_engine_update', { force });
  }

  async probeDirectLink(url: string): Promise<LinkProbe> {
    return invoke<LinkProbe>('probe_direct_link', { url });
  }

  async previewFilenameTemplate(template: string, vars: TemplateVars): Promise<string> {
    return invoke<string>('preview_filename_template', { template, vars });
  }

  persistence = {
    // Data is preloaded by init() before the UI renders.
    // Writes go to both the in-memory cache and disk.
    _queueCache: [] as DownloadItem[],
    _historyCache: [] as HistoryItem[],
    _settingsCache: null as AppPreferences | null,
    _subscriptionsCache: [] as Subscription[],
    // Shape-checked by stores/stats.ts on the way in, like settings.
    _statsCache: null as unknown,
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
      // What Rust saw finish, applied before anything can start: queue.json
      // may predate the last completions (stores/finished.ts).
      const finished = await invoke<FinishedDownload[]>('finished_downloads').catch(() => [] as FinishedDownload[]);
      this._queueCache = applyFinished(this._queueCache, finished, new Set(this._historyCache.map(h => h.id)));
      this._settingsCache = await readJson<AppPreferences | null>(FILES.settings, null);
      this._subscriptionsCache = await readJson<Subscription[]>(FILES.subscriptions, []);
      this._statsCache = await readJson<unknown>(FILES.stats, null);
    },

    loadQueue(): DownloadItem[] {
      return this._queueCache;
    },

    saveQueue: (items: DownloadItem[]) => {
      this.persistence._queueCache = items;
      if (this._initDone) {
        // Don't persist the (potentially large) per-file torrent breakdown — it's
        // runtime detail that repopulates from progress events on the next run.
        const slim = items.map(({ files: _files, pieces: _pieces, ...rest }) => rest);
        writeJson(FILES.queue, slim).catch(() => {});
      }
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

    loadStats(): unknown {
      return this._statsCache;
    },

    saveStats: (stats: unknown) => {
      this.persistence._statsCache = stats;
      if (this._initDone) writeJson(FILES.stats, stats).catch(() => {});
    },
  };
}
