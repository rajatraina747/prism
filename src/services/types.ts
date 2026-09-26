import type { MediaMetadata, DownloadItem, HistoryItem, AppPreferences, DiagnosticsEntry, PlaylistInfo, InspectResult, Subscription, TorrentFileInfo, TorrentFileEntry, TorrentPeer, TorrentDetails, SessionStats, WhenDoneAction, GlobalShortcuts, ShortcutAction, ConvertPreset } from '@/types/models';

export type { ConvertPreset };
import type { EngineError } from '@/services/errors';

export type ProgressCallback = (data: {
  downloadedBytes: number;
  totalBytes: number;
  progress: number;
  speed: number;
  eta: number;
  // HTTP-only: 'processing' while ffmpeg merges/extracts/embeds. The key is
  // always sent (possibly undefined) so a stale stage clears on the next tick.
  stage?: 'processing';
  // Torrent-only swarm stats; undefined for HTTP downloads.
  uploadSpeed?: number;
  peers?: number;
  peersSeen?: number;
  peersConnecting?: number;
  ratio?: number;
  files?: TorrentFileInfo[];
  uploadedBytes?: number;
  peerlessSecs?: number;
  pieces?: number[];
  // Torrent-only: download finished, now seeding. Drives downloading→seeding.
  seeding?: boolean;
}) => void;

export type CompletionCallback = (
  success: boolean,
  /** A structured EngineError from Rust; the web demo passes plain text. */
  error?: EngineError | string,
  filePath?: string,
  fileSize?: number,
  actualHeight?: number,
  /** Torrents: the folder the files were written to (a multi-file torrent
   * gets its own `<destination>/<name>` folder). */
  outputFolder?: string,
) => void;

/** Where a link came from. `external`: the OS handed it to Prism (a browser's
 * magnet:/prism:// link, a .torrent opened from Finder/Explorer) — nothing
 * proves the user meant it, so the UI confirms before any network action.
 * `app`: the user put it there inside Prism (tray Paste & Download, a drop). */
export type LinkOrigin = 'external' | 'app';

/** Mirrors `EngineInfo` in src-tauri/src/engine.rs. */
export interface EngineInfo {
  active: 'managed' | 'bundled';
  /** Null for a self-updated engine from before 2.0 (version never recorded). */
  activeVersion: string | null;
  bundledVersion: string;
  managedVersion: string | null;
  latest: string | null;
  checkedAt: string | null;
  updateAvailable: boolean;
}

/** Mirrors `TemplateVars` in src-tauri/src/template.rs. */
export interface TemplateVars {
  title?: string;
  uploader?: string;
  site?: string;
  id?: string;
  /** `YYYYMMDD` or RFC 3339. */
  date?: string;
  resolution?: string;
  /** The server's file name (direct links), extension included. */
  filename?: string;
  category?: string;
}

/** Mirrors `LinkProbe` in src-tauri/src/http_engine.rs. */
export interface LinkProbe {
  finalUrl: string;
  filename: string;
  size: number | null;
  acceptRanges: boolean;
  contentType: string | null;
}

export interface StorageSummary {
  folder: string;
  files: number;
  bytes: number;
  freeBytes: number;
  /** The walk stopped early — treat `files`/`bytes` as a floor. */
  partial: boolean;
}

/** A download already holding the same content. Mirrors `IndexEntry` in
 * src-tauri/src/content_index.rs. */
export interface ContentMatch {
  path: string;
  title: string;
  recordedAt: string;
}

export interface UpdateCheckResult {
  available: boolean;
  version?: string;
  notes?: string;
  error?: string;
}

export interface IPrismService {
  // Initialize the service (preload persistence data from disk)
  init?(): Promise<void>;
  /** True for the browser demo (simulated downloads, localStorage). The
   * shell shows a badge so a mock can never pass for the real app. */
  readonly isDemo?: boolean;

  // URL parsing & metadata
  parseUrl(url: string): Promise<MediaMetadata>;
  /** One lookup that says whether a link is a video (with its formats) or a
   * list (flat entries) — for anything a person adds. */
  inspectUrl(url: string, referer?: string): Promise<InspectResult>;
  /** For each path, whether it is a recorded download no longer on disk. */
  missingFiles(paths: string[]): Promise<boolean[]>;
  /** Stop the torrent engine so the next torrent starts it with the current
   * settings. Returns how many torrents were running. */
  restartTorrentEngine(): Promise<number>;
  /** Flat-parse a playlist/channel feed. `limit` caps to the newest N entries
   * (used by subscription polling; omit for full imports). */
  parsePlaylist(url: string, limit?: number): Promise<PlaylistInfo>;
  /** List a torrent's files without downloading (for the file picker). `dest`
   * is the intended destination directory. */
  parseTorrent(magnet: string, dest: string): Promise<TorrentFileEntry[]>;

  /** The desktop app's queue, owned by Rust (src-tauri/src/queue.rs). Absent
   * in the browser demo, which runs its queue in the page. */
  readonly queue?: RemoteQueue;
  /** Library entries Rust removed (a torrent deleted with its files). */
  onLibraryRemoved?(handler: (ids: string[]) => void): () => void;

  // Download lifecycle — returns a cancel/cleanup function
  startDownload(
    item: DownloadItem,
    onProgress: ProgressCallback,
    onComplete: CompletionCallback,
  ): () => void;

  pauseDownload(id: string): Promise<void>;
  cancelDownload(id: string): Promise<void>;
  /** Torrent-only: pause/resume in place. The engine keeps the torrent in its
   * session, so resuming needs no re-add and no hash re-check. Rejects if the
   * torrent isn't active (caller falls back to the kill-and-requeue path). */
  pauseTorrent(id: string): Promise<void>;
  resumeTorrent(id: string): Promise<void>;
  /** Torrent-only: change which files download, mid-torrent. Rejects when the
   * torrent isn't active or the selection is empty. */
  updateTorrentFiles(id: string, onlyFiles: number[]): Promise<void>;
  /** Session-wide torrent caps (bytes/sec; null = unlimited). The provider
   * merges the user's limits with Quiet Hours and pushes the effective pair. */
  setTorrentRateLimits(downloadBps: number | null, uploadBps: number | null): Promise<void>;
  /** Live session-wide cap for direct downloads (quiet hours); null = none. */
  setDirectRateLimit(bytesPerSecond: number | null): Promise<void>;
  /** "Update tracker": fresh announce to trackers/DHT/LSD; keeps progress. */
  reannounceTorrent(id: string): Promise<void>;
  /** "Force re-check": hash every piece on disk again. */
  recheckTorrent(id: string): Promise<void>;
  /** Stop a torrent and delete its files from disk. */
  removeTorrentData(id: string): Promise<void>;
  /** Peers of a live torrent (Peers tab; poll while visible). */
  getTorrentPeers(id: string): Promise<TorrentPeer[]>;
  /** Static facts about an active torrent (detail panel). */
  getTorrentDetails(id: string): Promise<TorrentDetails>;
  /** Session-wide engine stats stream (transfers footer). Returns unsubscribe. */
  onSessionStats(handler: (stats: SessionStats) => void): () => void;

  // File system operations
  openFile(filePath: string): Promise<void>;
  showInFolder(filePath: string): Promise<void>;
  /** Open an http(s) link in the user's browser — `target="_blank"` is inert
   *  inside the webview, so every outbound link goes through this. */
  openExternal(url: string): Promise<void>;
  pickDirectory(): Promise<string | null>;
  getDefaultDownloadPath(): Promise<string>;
  /** What a folder is holding and what its disk has left. The walk is capped,
   * so `partial` means the totals are a floor rather than a final answer. */
  storageSummary(folder: string): Promise<StorageSummary>;
  /** Move finished downloads to the OS Trash — recoverable there, unlike a
   * delete. Returns how many items were moved. */
  moveToTrash(paths: string[]): Promise<number>;

  /** Read an RSS/Atom feed, taking each entry's enclosure where it has one.
   * Returns the same shape as `parsePlaylist` so subscription checking doesn't
   * have to care which fetcher ran. */
  fetchRss(url: string, limit?: number): Promise<PlaylistInfo>;

  /** Register the user's global hotkeys, replacing whatever was registered
   * before. Rejects with the first accelerator the OS wouldn't give us —
   * usually because another application already holds it. */
  setShortcuts(shortcuts: GlobalShortcuts): Promise<void>;
  /** A registered global hotkey fired. Returns an unsubscribe function. */
  onShortcut(handler: (action: ShortcutAction) => void): () => void;

  /** Dock (macOS) and taskbar (Windows) progress, 0–100. `null` hides the bar.
   * What the number *is* comes from src/stores/progress.ts. */
  setProgress(percent: number | null, paused: boolean): Promise<void>;

  /** Record a finished file in the content index, and say whether the same
   * content was already there under a different name or from a different URL.
   * Only answerable once the file exists, so this runs after a download rather
   * than before one. */
  indexDownload(path: string, title: string): Promise<ContentMatch | null>;

  /** Someone chose something from the application menu. The payload is either
   * `add` or `nav:<path>` — the menu names an intent, and the shell decides
   * what that means, so navigation keeps going through one place. Returns an
   * unsubscribe function. */
  onMenuAction(handler: (action: string) => void): () => void;

  /** Convert a finished file. Reports through the same progress and completion
   * events a download uses, under `id`, so a conversion appears as another
   * running item. `durationSecs` comes from the item being converted, because
   * ffmpeg reports a position but never a total; 0 means the percentage is
   * left out rather than invented. */
  convertFile(id: string, input: string, preset: ConvertPreset, durationSecs: number): Promise<void>;

  // Clipboard
  copyToClipboard(text: string): Promise<void>;
  readClipboard(): Promise<string>;

  /** OS-level notification — reaches the user when the window is hidden or in
   * the tray, where in-app toasts are invisible. Best-effort (no-op if the OS
   * denies permission). */
  notify(title: string, body: string): Promise<void>;
  /** Sleep, shut down, or quit once the queue has finished. Deciding *when* is
   * src/stores/completion.ts; this only carries it out. */
  whenDone(action: WhenDoneAction): Promise<void>;

  // Deep links (prism://add?url=..., magnet:, .torrent files, tray paste) —
  // handler receives the extracted URL and where it came from.
  // Returns an unsubscribe function.
  onDeepLink(handler: (url: string, origin: LinkOrigin) => void): () => void;
  /** A dropped `.torrent` (bytes only — drops carry no path). Returns a magnet
   * for it; the engine adds it from the stored bytes. */
  importTorrentFile(name: string, bytes: Uint8Array): Promise<string>;
  /** Native "Open .torrent" picker; null when cancelled or unavailable. */
  pickTorrentFile(): Promise<string | null>;

  // System
  exportLogs(logs: DiagnosticsEntry[]): Promise<void>;
  /** Save a backup file where the user picks; false if they cancelled. */
  saveBackup(json: string, suggestedName: string): Promise<boolean>;
  /** Pick another client's folder and read its torrents; null if cancelled. */
  importTorrentClient(client: 'qbittorrent' | 'transmission'): Promise<{ torrents: { magnet: string; savePath: string | null }[]; skipped: number } | null>;
  /** Read a backup file the user picks; null if they cancelled. */
  openBackup(): Promise<string | null>;
  /** Whether ffmpeg is installed — merges, embedding, and SponsorBlock need it. */
  ffmpegAvailable(): Promise<boolean>;
  checkForUpdates(): Promise<UpdateCheckResult>;
  installUpdate(onProgress?: (downloaded: number, total: number | null) => void): Promise<void>;
  getAppVersion(): Promise<string>;

  // yt-dlp engine management — the engine can be updated independently of the app
  getEngineVersion(): Promise<string>;
  updateEngine(): Promise<string>;
  resetEngine(): Promise<void>;
  /** Which engine runs and whether a newer yt-dlp exists (no network). */
  getEngineInfo(): Promise<EngineInfo>;
  /** Ask GitHub for the newest yt-dlp; reuses a lookup under a day old unless `force`. */
  checkEngineUpdate(force?: boolean): Promise<EngineInfo>;
  /** What an http(s) link points at — a file (name, size) or a web page. */
  probeDirectLink(url: string, referer?: string): Promise<LinkProbe>;
  /** The relative path a file name template produces for `vars`; rejects with
   * the template's mistake (unknown placeholder, unclosed brace). */
  previewFilenameTemplate(template: string, vars: TemplateVars): Promise<string>;

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
    /** Download counters. Their own record rather than a view of history,
     * which is capped and forgets. */
    loadStats(): unknown;
    saveStats(stats: unknown): void;
  };
}

/** The page's handle on Rust's queue: its actions, and its events. */
export interface RemoteQueue {
  snapshot(): Promise<DownloadItem[]>;
  add(item: DownloadItem): Promise<void>;
  remove(id: string): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  pauseAll(): Promise<void>;
  resumeAll(): Promise<void>;
  clearCompleted(): Promise<void>;
  reorder(from: number, to: number): Promise<void>;
  /** Replace an item's settings while it is still `onlyIf` (a start that
   * happened meanwhile keeps what it started with). */
  setSettings(id: string, settings: DownloadItem['settings'], onlyIf?: DownloadItem['status']): Promise<boolean>;
  updateTorrentFiles(id: string, files: number[]): Promise<void>;
  removeWithData(id: string): Promise<void>;
  restartTorrentEngine(): Promise<number>;
  cancelWhenDone(): Promise<void>;
  /** Listen to the queue; returns the function that stops listening. */
  subscribe(handlers: {
    changed: (patch: import('@/stores/remote-queue').QueuePatch) => void;
    archived: (entries: import('@/stores/remote-queue').ArchivedEntry[]) => void;
    notice: (notice: import('@/stores/remote-queue').QueueNotice) => void;
    whenDone: (countdown: { action: import('@/types/models').WhenDoneAction; seconds: number }) => void;
  }): () => void;
}
