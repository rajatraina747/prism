export type DownloadStatus =
  | 'queued'
  | 'parsing'
  | 'ready'
  | 'downloading'
  // Torrent-only: download hit 100% but is still uploading to the swarm.
  // Terminal-ish — transitions to 'completed' when seeding stops (ratio met
  // or user action). See seedingPolicy.
  | 'seeding'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled';

// How an item is fetched. Absent = 'http' (yt-dlp), the default for every
// existing item. 'torrent' routes through the librqbit engine instead.
export type DownloadKind = 'http' | 'torrent' | 'direct' | 'convert';

/** The conversions offered. Mirrors `Preset` in src-tauri/src/convert.rs,
 * which serialises kebab-case. Deliberately a short list of destinations
 * rather than a codec matrix: every extra option is one more way to end up
 * with a file that won't play.
 *
 * Here rather than in services/types.ts because that file imports from this
 * one — a download setting referring the other way would be a cycle. */
export type ConvertPreset = 'mp4-h264' | 'mp4-hevc' | 'mp4-remux' | 'mp3' | 'm4a' | 'opus';

/** What Prism does once the queue finishes. The logic lives in
 * src/stores/completion.ts; the type lives here with the rest so settings and
 * that module don't have to import each other. */
export type WhenDoneAction = 'nothing' | 'sleep' | 'shutdown' | 'quit';

/** What to do with one download the moment it finishes. Per item, falling
 * back to a default in settings; see src/stores/completion.ts. */
export type PostCompletionAction = 'nothing' | 'notify' | 'open' | 'reveal';

// One file inside a (multi-file) torrent, with per-file progress percent.
export interface TorrentFileInfo {
  name: string;
  size: number;
  progress: number;
}

// A file listed from a torrent's metadata before downloading (file picker).
// `index` is what the engine's file selection expects.
export interface TorrentFileEntry {
  index: number;
  name: string;
  size: number;
}

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
  /** 30 or 60 (frame-rate class). Absent on formats saved before 2.3. */
  fps?: number;
  hdr?: boolean;
  /** False for VP9/AV1: plays in VLC, IINA and browsers but not QuickTime or
   * Photos. Absent (older items) means it was H.264. */
  playsEverywhere?: boolean;
}

export interface AudioTrack {
  code: string;
  name: string;
  original: boolean;
}

export interface MediaMetadata {
  title: string;
  duration: number;
  thumbnail: string;
  source: MediaSource;
  formats: FormatOption[];
  description?: string;
  uploader?: string;
  /** `<extractor>:<id>` from yt-dlp: the same video however its URL is
   * written. Absent for torrents, direct files and older records. */
  mediaKey?: string;
  /** Several audio tracks (YouTube's dubs), original first. Absent: one. */
  audioTracks?: AudioTrack[];
  /** Subtitles the uploader provided (not machine translations). */
  subtitleLanguages?: { code: string; name: string }[];
}

export interface DownloadSettings {
  format: FormatOption | null;
  destination: string;
  filename: string;
  /** Copied from the setting when queued, and no longer read: the budget is
   * the current "Retries on failure" setting (stores/retry.ts). Kept because
   * saved queues carry it. */
  retryCount: number;
  startImmediately: boolean;
  audioOnly?: boolean;
  downloadSubtitles?: boolean;
  /** One code, or several comma-separated (`en,es`). */
  subtitleLanguage?: string;
  /** Put the subtitles inside the video file (needs ffmpeg). */
  embedSubtitles?: boolean;
  /** A dub to download instead of the original track (see audioTracks). */
  audioLanguage?: string;
  speedLimit?: number; // bytes per second, 0 = unlimited
  // Torrent-only: indices of files to download. Undefined = all files.
  selectedFiles?: number[];
  // The file name template in force when the item was queued (not for
  // torrents). Fixed per item, so a resume finds its partial file even if the
  // preference changed meanwhile. Absent = the plain title, as before 2.0.
  filenameTemplate?: string;
  // The category this item was sorted into when it was queued, and its name
  // at that moment (kept so the row still reads right if the category is
  // renamed or deleted later).
  categoryId?: string;
  categoryName?: string;
  // Labels put on this item by hand. Ids only: the names live in settings, so
  // renaming a label renames it everywhere at once. Absent = none.
  labelIds?: string[];
  // yt-dlp only: don't hand this item the browser's cookies even when the
  // setting is on. Set for a subscription entry on a different site than the
  // subscription itself — a feed's links must not become logged-in requests
  // to arbitrary sites (REVIEW 2026-09-26 M1). Absent = the setting decides.
  noCookies?: boolean;
  // Direct downloads only: a SHA-256 the finished file has to match, as 64
  // lower-case hex digits. Absent = downloaded without being checked.
  sha256?: string;
  // What to do when this one finishes. Absent = whatever the setting says.
  whenComplete?: PostCompletionAction;
  // Don't start this one before this time (RFC 3339). Absent = start when its
  // turn comes. It holds back only this item: the rest of the queue carries on
  // without it.
  startAt?: string;
  // Download part of the video rather than all of it: "1:23" / "0:01:23" /
  // "83". Either end may be left out (from the beginning, or to the end).
  // Validated Rust-side into a range yt-dlp is given; see src-tauri/src/clip.rs.
  clipStart?: string;
  clipEnd?: string;
  // Write one file per chapter. Ignored when a clip range is set, since
  // splitting the chapters of an excerpt describes two different cuts.
  splitChapters?: boolean;
  // Conversion items (`kind: 'convert'`) only: which preset to run. The source
  // file is the item's source URL, which for these is a path on disk.
  convertPreset?: ConvertPreset;
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

/** What a link turned out to be (Rust `lookup::inspect_url`): one video with
 * its formats, or a list of entries. */
export type InspectResult =
  | { kind: 'video'; metadata: MediaMetadata }
  | { kind: 'playlist'; playlist: PlaylistInfo };

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
  /** Video height actually delivered (reported by yt-dlp at completion) —
   * compared against settings.format to flag silent quality degradation. */
  actualHeight?: number;
  error?: DownloadError;
  retryAttempt: number;
  // 'processing' while yt-dlp hands off to ffmpeg (merge/extract/embed) —
  // bytes stop moving but the download isn't done. Absent otherwise.
  stage?: 'processing';
  // Source engine. Absent/'http' = yt-dlp; 'torrent' = librqbit; 'direct' =
  // the direct-link engine (plain files). The torrent fields below are only
  // populated while kind === 'torrent'.
  kind?: DownloadKind;
  peers?: number;
  // Swarm health: peers discovered / mid-handshake. 0 connected + 0 seen =
  // dead swarm; 0 connected + many seen = connectivity problem.
  peersSeen?: number;
  peersConnecting?: number;
  uploadSpeed?: number; // bytes per second
  ratio?: number; // uploaded / downloaded
  files?: TorrentFileInfo[]; // multi-file torrent breakdown
  /** Lifetime bytes uploaded (survives pause/reannounce, unlike the engine's counter). */
  uploadedBytes?: number;
  /** Consecutive seconds with zero connected peers; 0 while connected. */
  peerlessSecs?: number;
  /** Have-pieces bitmap downsampled to ~200 buckets (0–255 fill). Not persisted. */
  pieces?: number[];
  /** When the item entered the queue (set by the reducer on add). */
  addedAt?: string;
  /** Torrent only: the folder the files were written to. A multi-file torrent
   * gets its own `<destination>/<name>` folder, so `files[].name` (relative
   * to this) must be joined against it, not against settings.destination. */
  outputFolder?: string;
}

/** One peer of a live torrent (Peers tab). Speeds are differenced per poll. */
export interface TorrentPeer {
  addr: string;
  client?: string | null;
  kind: string; // tcp | utp | socks | unknown
  state: string; // queued | connecting | live | dead | not needed
  downBps: number;
  upBps: number;
  downloaded: number;
  uploaded: number;
  errors: number;
}

/** Static facts about an active torrent (General/Trackers tabs). */
export interface TorrentDetails {
  infoHash: string;
  name?: string | null;
  outputFolder: string;
  totalBytes: number;
  totalPieces: number;
  pieceLength: number;
  private: boolean;
  trackers: string[];
  fileCount: number;
  addedAt: string;
  state: string;
}

/** Session-wide torrent engine numbers (transfers footer). */
export interface SessionStats {
  downloadBps: number;
  uploadBps: number;
  peersLive: number;
  peersConnecting: number;
  peersSeen: number;
  dhtNodes: number;
  listenPort?: number | null;
  upnp: boolean;
  dht: boolean;
  utp: boolean;
  activeTorrents: number;
}

export type TransfersSort = 'added' | 'name' | 'progress' | 'speed' | 'eta' | 'size' | 'ratio';
export type TransfersFilter = 'all' | 'downloading' | 'seeding' | 'paused' | 'queued' | 'errored';

/** How the Library is ordered. Separate from TransfersSort: a finished
 * download has no speed, ETA or progress to sort on. */
export type LibrarySort = 'newest' | 'oldest' | 'title' | 'size';

/** Library layout. A grid leads with the thumbnail, which is the useful
 * handle for finished video; a list leads with the title. */
export type LibraryView = 'list' | 'grid';

/** How tightly rows are packed, on the Library and Transfers alike. */
export type ListDensity = 'comfortable' | 'compact';

export interface DownloadError {
  code: string;
  message: string;
  category: 'network' | 'parse' | 'permission' | 'storage' | 'auth' | 'unknown';
  timestamp: string;
  suggestion?: string;
  /** Rust's classification (2.0+); absent on failures saved before 2.0. */
  engineCode?: import('@/services/errors').EngineErrorCode;
  /** The engine's own output, redacted in Rust — for the tooltip. */
  detail?: string;
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
  // Which days quiet hours apply on (0 = Sunday … 6 = Saturday). Absent or
  // empty means every day, so a schedule set before this existed is unchanged.
  // An overnight window belongs to the day it started on — see schedule.ts.
  scheduleDays?: number[];
  // Opt-in crash reporting (Sentry). Off by default; also requires the app to
  // have been built with a DSN. Frontend toggles live; Rust panics follow the
  // setting on next launch.
  crashReportingEnabled: boolean;
  // Container/codec for audio-only downloads. Read by the Rust side from
  // settings.json (whitelisted), like cookiesFromBrowser.
  audioFormat: 'mp3' | 'm4a' | 'opus';
  // Video: skip the forced MP4 remux so VP9/AV1 stay in mkv/webm (some
  // players mishandle those codecs inside .mp4). Read Rust-side. Default off.
  keepOriginalContainer: boolean;
  // First-run setup card on the Dashboard (destination, ffmpeg, cookies).
  setupCardDismissed: boolean;
  // Torrent seeding: what to do once a torrent finishes downloading.
  // 'stop' = stop uploading immediately, 'ratio' = seed until share ratio 1.0
  // (good swarm citizen, bounded upload), 'seed' = seed until manually stopped.
  // Read by the Rust side from settings.json (whitelisted), like audioFormat.
  seedingPolicy: 'stop' | 'ratio' | 'seed';
  // Optional proxy. yt-dlp and direct downloads route everything through
  // http(s)/socks proxies;
  // the torrent engine routes only *peer connections* through a socks5://
  // proxy (DHT, trackers and the .torrent/blocklist fetches go direct, and
  // http proxies are ignored for torrents). Empty = direct. Validated Rust-side.
  proxyUrl: string;
  // Torrent engine: open a router port via UPnP for inbound peers (better
  // swarm health, but publishes this machine's reachability). Read Rust-side.
  torrentUpnp: boolean;
  // Torrent engine: join the DHT (off = tracker-only). Read Rust-side.
  torrentDht: boolean;
  // Torrent engine (all read Rust-side at engine start, i.e. next launch):
  // uTP transport alongside TCP; LAN peer discovery; fixed listen port; max
  // peers per torrent (0 = engine default).
  torrentUtp: boolean;
  torrentLsd: boolean;
  torrentListenPort: number;
  torrentPeerLimit: number;
  // Give up on a torrent that has had no peers for N minutes (0 = never —
  // it keeps re-announcing every 5 minutes, like uTorrent/Vuze). Rust-side.
  torrentGiveUpMinutes: number;
  // Seeding: ratio target for the 'ratio' policy, and an optional wall-clock
  // limit (minutes, 0 = none) that ends seeding under any policy but 'stop'.
  seedRatioTarget: number;
  seedTimeLimitMinutes: number;
  // Session-wide torrent speed caps in KB/s (0 = unlimited). Applied live;
  // the quiet-hours override caps them further while active.
  torrentDownloadLimitKBps: number;
  torrentUploadLimitKBps: number;
  // Transfers page memory.
  transfersSort: TransfersSort;
  transfersFilter: TransfersFilter;
  // Library page memory, the same way the two above remember Transfers.
  librarySort: LibrarySort;
  libraryView: LibraryView;
  // Applies to both lists. Compact fits roughly a third more rows on screen.
  listDensity: ListDensity;
  detailPanelHeight: number;
  // Offer to fetch video URLs found on the clipboard when the window regains
  // focus. Reads the clipboard, so it's a user choice.
  clipboardWatchEnabled: boolean;
  // Extra tracker announce URLs added to every torrent (newline- or comma-
  // separated). Helps peer discovery on magnets with dead/few trackers.
  // Read by the Rust side from settings.json (filtered to http(s)/udp).
  extraTrackers: string;
  // IP blocklist URL for the torrent engine (standard p2p formats, gz ok).
  // Applied when the engine starts — takes effect on next launch. Empty = off.
  blocklistUrl: string;
  // Remembered quality preset per domain (host -> preset id). When you add a URL
  // from a site you've used before, its last-used preset is pre-selected.
  perSitePresets: Record<string, string>;
  // Pass --force-ipv4 to yt-dlp (lookups and downloads). Many sites throttle
  // IPv6 downloads; on by default, which was the hardcoded behaviour before
  // 1.9. Read Rust-side.
  forceIpv4: boolean;
  // Compare the yt-dlp engine with its newest release once a day (cached in
  // Rust) and nudge in the sidebar when it's behind.
  engineAutoCheck: boolean;
  // Install a newer engine as soon as the daily check finds one.
  engineAutoUpdate: boolean;
  // How new downloads are named, e.g. "{uploader}/{title}" (a / makes a
  // subfolder). Rendered and made safe in Rust (src-tauri/src/template.rs).
  filenameTemplate: string;
  // Move each finished download out of the working folder (torrents once
  // seeding ends). Read Rust-side; nothing is ever overwritten.
  moveCompletedEnabled: boolean;
  moveCompletedTo: string;
  // Folders Prism watches for .torrent files and text files of links. Scanned
  // Rust-side; a handled file is renamed, never deleted.
  watchFolders: { path: string; enabled: boolean }[];
  // Categories sort downloads as they arrive: the first whose rules match an
  // item gives it a destination and a file name template. Assigned once, when
  // the item is queued.
  categories: DownloadCategory[];
  // Labels are put on downloads by hand, several at a time. Unlike a category
  // they carry no settings — they only group things after the fact.
  labels: DownloadLabel[];
  // What to do once the queue finishes. Fires on the transition from working
  // to finished, never on a standing start; see src/stores/completion.ts.
  // What happens as each download finishes, unless the item says otherwise.
  defaultWhenComplete: PostCompletionAction;
  whenDoneAction: WhenDoneAction;
  // Seeding counts as work by default, so a machine doesn't sleep in the
  // middle of uploading. This waives that.
  whenDoneIgnoresSeeding: boolean;
  // Closing the main window hides it and downloads carry on; Quit (tray, menu,
  // ⌘Q) asks first while anything runs. Off = closing the window quits (still
  // asking first). Read Rust-side (src-tauri/src/lifecycle.rs).
  closeToTray: boolean;
  // Optional global hotkeys — off unless the user assigns one, because a
  // shortcut registered system-wide takes that key away from every other app.
  // Registered Rust-side; see src-tauri/src/shortcuts.rs.
  shortcuts: GlobalShortcuts;
  // The shape these settings were written in, so a later rename can migrate
  // them rather than read as the user unsetting something. Anything written
  // before 2.0 has no stamp at all; see src/stores/settings-migrations.ts.
  settingsVersion: number;
}

/** Bumped whenever a stored setting changes shape, with a matching step in
 * src/stores/settings-migrations.ts. */
export const SETTINGS_VERSION = 1;

/** System-wide hotkeys, each an accelerator like "CommandOrControl+Shift+V".
 *
 * An empty string means unassigned, which is the default for all of them: a
 * global shortcut is taken from every other application on the machine, so
 * Prism should never claim one the user didn't ask for. */
export interface GlobalShortcuts {
  /** Add whatever link is on the clipboard, without raising the window. */
  addFromClipboard: string;
  /** Bring Prism to the front from wherever the user is. */
  showPrism: string;
  /** Pause every running download. */
  pauseAll: string;
}

/** Which global hotkey fired. Keyed off GlobalShortcuts so the two can never
 * drift apart. */
export type ShortcutAction = keyof GlobalShortcuts;

/** A tag the user can put on any download, independent of its category. */
export interface DownloadLabel {
  id: string;
  name: string;
}

/** A rule for sorting downloads, with the settings that come with it. */
export interface DownloadCategory {
  id: string;
  name: string;
  /** Where its downloads go; empty = the default download folder. */
  destination: string;
  /** File names for its downloads; empty = the default template. */
  filenameTemplate: string;
  /** Hosts it claims (`youtube.com`, matched on the site and its subdomains).
   * Empty means "any host". */
  domains: string[];
  /** Engines it claims; empty means "any". */
  kinds: DownloadKind[];
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
  /** How the feed is read. Absent means 'channel' — yt-dlp's flat playlist
   * dump, which is what every subscription before 2.0 was — so existing
   * subscriptions keep working untouched. 'rss' parses an RSS/Atom feed and
   * takes its enclosures, which may be torrents or plain files rather than
   * pages yt-dlp understands. */
  type?: 'channel' | 'rss';
  addedAt: string;
  enabled: boolean;
  audioOnly: boolean;
  seenUrls: string[];
  lastCheckedAt?: string;
  lastError?: string;
  // Which of a feed's videos to actually take. Matched against the title and
  // the URL — a flat feed entry carries nothing else to match on. Absent (or
  // empty) means take everything, so older subscriptions are unaffected.
  includeKeywords?: string[];
  excludeKeywords?: string[];
  /** File everything from this feed under a category, as if it had been
   * added by hand with that category chosen. */
  categoryId?: string;
}

export interface HistoryItem {
  id: string;
  metadata: MediaMetadata;
  settings: DownloadSettings;
  status: 'completed' | 'failed' | 'canceled';
  completedAt: string;
  fileSize: number;
  /** Total size when known — lets a retry start with the real size instead
   * of a placeholder (torrents otherwise need peers just to learn it). */
  totalBytes?: number;
  filePath?: string;
  error?: DownloadError;
  /** Torrent only: downloaded files (paths relative to `outputFolder`, or to
   * settings.destination for items recorded before 1.8.1), so the Library can
   * play/reveal each one individually. */
  files?: { name: string; size: number }[];
  /** Torrent only: see DownloadItem.outputFolder. */
  outputFolder?: string;
  /** Video height actually delivered, when it differs from what the format
   * label promised (see DownloadItem.actualHeight). */
  actualHeight?: number;
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  defaultSaveFolder: '~/Downloads/Prism',
  maxConcurrentDownloads: 3,
  bandwidthLimit: 0,
  defaultRetryCount: 3,
  theme: 'dark',
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
  crashReportingEnabled: false,
  audioFormat: 'mp3',
  keepOriginalContainer: false,
  setupCardDismissed: false,
  seedingPolicy: 'ratio',
  proxyUrl: '',
  torrentUpnp: true,
  torrentDht: true,
  torrentUtp: false,
  torrentLsd: true,
  torrentListenPort: 4240,
  torrentPeerLimit: 0,
  torrentGiveUpMinutes: 0,
  seedRatioTarget: 1,
  seedTimeLimitMinutes: 0,
  torrentDownloadLimitKBps: 0,
  torrentUploadLimitKBps: 0,
  transfersSort: 'added',
  transfersFilter: 'all',
  detailPanelHeight: 260,
  clipboardWatchEnabled: true,
  extraTrackers: '',
  blocklistUrl: '',
  perSitePresets: {},
  forceIpv4: true,
  engineAutoCheck: true,
  engineAutoUpdate: false,
  filenameTemplate: '{title}',
  moveCompletedEnabled: false,
  moveCompletedTo: '',
  watchFolders: [],
  categories: [],
  labels: [],
  defaultWhenComplete: 'nothing',
  whenDoneAction: 'nothing',
  whenDoneIgnoresSeeding: false,
  closeToTray: true,
  librarySort: 'newest',
  libraryView: 'list',
  listDensity: 'comfortable',
  // All unassigned: Prism claims no system-wide key until asked to.
  shortcuts: { addFromClipboard: '', showPrism: '', pauseAll: '' },
  settingsVersion: SETTINGS_VERSION,
};

export const DEFAULT_PRESETS: DownloadPreset[] = [
  { id: 'best', name: 'Best Quality', resolution: 'Best', container: 'mp4', quality: 'best' },
  { id: '4k', name: '4K Ultra HD', resolution: '2160p', container: 'mp4', quality: 'best' },
  { id: '1080p', name: 'Full HD', resolution: '1080p', container: 'mp4', quality: 'high' },
  { id: '720p', name: 'HD Ready', resolution: '720p', container: 'mp4', quality: 'medium' },
  { id: 'compact', name: 'Compact', resolution: '480p', container: 'mp4', quality: 'low' },
  // H.264 only (up to 1080p on YouTube): plays in QuickTime, Photos and on
  // iPhones, where VP9/AV1 at higher resolutions don't.
  { id: 'compatible', name: 'Compatible (H.264)', resolution: '1080p', container: 'mp4', quality: 'high' },
];
