import React, { useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueue, useHistory, useSettings } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { toast } from 'sonner';
import { UrlInput } from '@/components/dashboard/UrlInput';
import { SetupCard } from '@/components/dashboard/SetupCard';
import { QuietHoursBanner } from '@/components/common/QuietHoursBanner';
import { MediaDetailsModal } from '@/components/media-details/MediaDetailsModal';
import { PlaylistModal } from '@/components/media-details/PlaylistModal';
import { TorrentFilesModal } from '@/components/media-details/TorrentFilesModal';
import { Panel, ProgressBar, Thumb, OutboundLink } from '@/components/common';
import { DEFAULT_PRESETS, type MediaMetadata, type DownloadItem, type DownloadPreset, type FormatOption, type PlaylistInfo, type PlaylistEntry, type InspectResult, type TorrentFileEntry } from '@/types/models';
import { buildTorrentItem } from '@/stores/torrent-item';
import { findDuplicate, findMediaDuplicate } from '@/stores/dedupe';
import { generateId, formatBytes, formatSpeed, isTorrentUrl, isDirectFileUrl, directFileName, torrentDisplayName, siteKey, sanitizeFilename, mixVideoUrl } from '@/services';
import { useClipboardWatcher } from '@/hooks/use-clipboard-watcher';
import { consumeDeepLinks } from '@/lib/deep-link-bus';
import { createLimiter } from '@/lib/limit';
import { COOKIES_SETTINGS_PATH, ENGINE_SETTINGS_PATH } from '@/lib/nav-bus';
import { classifyError, conciseError, errorText, type ErrorText } from '@/services/errors';
import { cn } from '@/lib/utils';
import {
  Sparkles, Loader2, ArrowDownToLine, Gauge, CheckCircle2, HardDrive, Play, FolderOpen,
  Film, ListMusic,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

function StatTile({ icon: Icon, value, label, delay }: { icon: React.ElementType; value: string; label: string; delay: number }) {
  return (
    <div
      className="glass-strong rounded-xl px-3.5 py-3 flex items-center gap-3 animate-fade-in"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-primary" strokeWidth={1.8} />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground tabular-nums truncate">{value}</p>
        <p className="text-[11px] text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

/** Lookups a pasted batch runs at once (the backend allows six). */
const BATCH_LOOKUPS = 4;

/** Pick the format that best matches a preset's target resolution. */
function pickFormatForPreset(formats: FormatOption[], preset: DownloadPreset): FormatOption | undefined {
  if (preset.resolution === 'Best') return formats[0]; // formats are sorted descending
  if (preset.id === 'compatible') {
    // The best option that plays everywhere, else the strict H.264 filter.
    const cap = parseInt(preset.resolution, 10);
    return formats.find(f => f.playsEverywhere !== false && !f.hdr && parseInt(f.resolution, 10) <= cap)
      ?? presetToFormat(preset) ?? undefined;
  }
  return formats.find(f => f.resolution === preset.resolution) || formats[0];
}

/** Synthesize a FormatOption for a preset without a per-video format list —
 * the id mirrors the backend's H.264/AAC-first yt-dlp filter chain, capped at
 * the preset's height. 'Best' returns null (backend default = best available). */
function presetToFormat(preset: DownloadPreset): FormatOption | null {
  if (preset.resolution === 'Best') return null;
  const h = parseInt(preset.resolution, 10);
  if (!h) return null;
  if (preset.id === 'compatible') {
    return {
      id: `bestvideo[height<=${h}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=${h}][vcodec^=avc1]/best[height<=${h}]`,
      label: `${preset.resolution} · H.264`,
      resolution: preset.resolution,
      container: 'mp4',
      codec: 'H.264',
      fileSize: 0,
      quality: 'high',
      playsEverywhere: true,
    };
  }
  return {
    id: `bestvideo[height<=${h}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=${h}][vcodec^=avc1]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`,
    label: `${preset.resolution} · H.264 when available`,
    resolution: preset.resolution,
    container: 'mp4',
    codec: 'H.264',
    fileSize: 0,
    quality: (preset.quality as FormatOption['quality']) || 'high',
  };
}

/** Build a queue item for a direct file link. Skips yt-dlp; the engine takes
 * the real name and size from the server when it starts. */
function buildDirectItem(url: string, destination: string, speedLimit?: number, title = directFileName(url)): DownloadItem {
  let domain = 'download';
  try { domain = new URL(url).hostname; } catch { /* checked by isDirectFileUrl */ }
  return {
    id: generateId(),
    metadata: {
      title,
      duration: 0,
      thumbnail: '',
      source: { url, domain, addedAt: new Date().toISOString() },
      formats: [],
    },
    settings: {
      format: null,
      destination,
      filename: title,
      retryCount: 0,
      startImmediately: true,
      speedLimit,
    },
    status: 'queued',
    progress: 0,
    speed: 0,
    eta: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    retryAttempt: 0,
    kind: 'direct',
  };
}

/** A YouTube watch URL that also carries a playlist: return both "just this
 * video" and "whole playlist" forms so the user can choose. Null when the URL
 * isn't ambiguous. Mix/radio pseudo-playlists (list=RD…) aren't real playlists
 * — treat those as plain videos. */
function watchWithListInfo(url: string): { videoUrl: string; playlistUrl: string } | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
    if (host !== 'youtube.com' && host !== 'music.youtube.com') return null;
    const v = u.searchParams.get('v');
    const list = u.searchParams.get('list');
    if (!v || !list || list.startsWith('RD')) return null;
    return {
      videoUrl: `https://www.youtube.com/watch?v=${v}`,
      playlistUrl: `https://www.youtube.com/playlist?list=${list}`,
    };
  } catch {
    return null;
  }
}

/** One-line summary of a link for the confirmation card. */
function describeExternalLink(url: string): string {
  if (isTorrentUrl(url)) return `Torrent · ${torrentDisplayName(url)}`;
  try { return new URL(url).hostname; } catch { return url; }
}

/** A queue item for one entry of a list, straight from the flat lookup
 * (title, duration and thumbnail are already known): no per-video lookup, and
 * `format` is the preset's synthesized filter, resolved when it starts. */
function playlistEntryItem(
  entry: PlaylistEntry,
  format: FormatOption | null,
  destination: string,
  retryCount: number,
  speedLimit: number | undefined,
): DownloadItem {
  return {
    id: generateId(),
    metadata: {
      title: entry.title,
      duration: entry.duration,
      thumbnail: entry.thumbnail,
      source: { url: entry.url, domain: siteKey(entry.url) ?? 'unknown', addedAt: new Date().toISOString() },
      formats: [],
    },
    settings: {
      format,
      destination,
      filename: sanitizeFilename(entry.title),
      retryCount,
      startImmediately: true,
      speedLimit,
    },
    status: 'queued',
    progress: 0,
    speed: 0,
    eta: 0,
    downloadedBytes: 0,
    totalBytes: 500_000_000,
    retryAttempt: 0,
  };
}

export default function Dashboard() {
  const { items: queueItems, addToQueue } = useQueue();
  const { items: historyItems } = useHistory();
  const { preferences, updatePreference } = useSettings();
  const service = useService();
  const navigate = useNavigate();
  const [parseError, setParseError] = useState<ErrorText | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parsedMetadata, setParsedMetadata] = useState<MediaMetadata | null>(null);
  const [showMediaModal, setShowMediaModal] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ total: number; done: number } | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<DownloadPreset>(DEFAULT_PRESETS[2]); // Full HD default

  // Playlist state
  const [parsedPlaylist, setParsedPlaylist] = useState<PlaylistInfo | null>(null);
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);

  // Torrent file-picker state
  const [showTorrentModal, setShowTorrentModal] = useState(false);
  const [torrentUrl, setTorrentUrl] = useState<string>('');
  const [torrentFiles, setTorrentFiles] = useState<TorrentFileEntry[] | null>(null); // null = loading

  // A watch URL that also names a playlist — ask which the user meant.
  const [listChoice, setListChoice] = useState<{ videoUrl: string; playlistUrl: string } | null>(null);

  const activeDownloads = useMemo(() => queueItems.filter(i => i.status === 'downloading'), [queueItems]);
  const totalSpeed = useMemo(() => activeDownloads.reduce((s, i) => s + (i.speed || 0), 0), [activeDownloads]);
  const completedHistory = useMemo(() => historyItems.filter(i => i.status === 'completed'), [historyItems]);
  const totalDownloadedBytes = useMemo(() => completedHistory.reduce((s, i) => s + (i.fileSize || 0), 0), [completedHistory]);
  const recentDownloads = useMemo(() => completedHistory.slice(0, 3), [completedHistory]);
  // Parse errors get the same treatment as failed downloads: the engine's
  // line, what to do, and the action that can fix it.
  const parseProblem = useMemo(() => {
    if (!parseError) return null;
    const { suggestion, action } = classifyError(parseError.message, parseError.engineCode);
    return { message: conciseError(parseError.message), suggestion, action };
  }, [parseError]);

  // Ref indirection so the clipboard watcher callback stays stable
  const handleUrlSubmitRef = useRef<(url: string) => void>(() => {});
  // The link behind the current parse error, for its Retry action.
  const lastParsedUrlRef = useRef('');
  const handleBatchSubmitRef = useRef<(urls: string[]) => void>(() => {});
  // Monotonic token so a slow parseTorrent (up to ~45s) can't populate or close a
  // modal the user has since moved on from. Bumped on new parse / close / confirm.
  const torrentParseIdRef = useRef(0);
  // Set when the user cancels a playlist/batch run; the parse loops check it
  // each iteration and stop, keeping whatever was queued so far.
  const abortBulkRef = useRef(false);

  // Links buffered by AppShell so ones arriving on other pages aren't lost.
  // Links from outside Prism — a browser's magnet:/prism:// link, a .torrent
  // the OS opened — wait for an explicit OK (S-6): a web page can fire them
  // with no user intent, and even the lookup reaches the network (a magnet
  // joins the swarm for metadata; a URL runs yt-dlp with the user's browser
  // cookies). In-app links (tray paste, drops) go straight in.
  const [externalLinks, setExternalLinks] = useState<string[]>([]);
  React.useEffect(() => consumeDeepLinks((urls, origin) => {
    if (origin === 'external') {
      setExternalLinks(q => [...q, ...urls.filter(u => !q.includes(u))]);
      return;
    }
    // Several links at once (Add sheet, a drop): the batch flow, which
    // parses and queues each with the selected preset.
    if (urls.length > 1) {
      handleBatchSubmitRef.current(urls);
      return;
    }
    handleUrlSubmitRef.current(urls[0]);
  }), []);
  const pendingExternalLink = externalLinks[0] ?? null;
  const settleExternalLink = useCallback((add: boolean) => {
    const url = externalLinks[0];
    setExternalLinks(q => q.slice(1));
    if (add && url) handleUrlSubmitRef.current(url);
  }, [externalLinks]);

  // Offer to fetch video URLs found on the clipboard when the app regains
  // focus — a user-controlled setting, since it means reading the clipboard.
  useClipboardWatcher(useCallback((url: string) => {
    toast('Video link on clipboard', {
      description: url,
      action: { label: 'Fetch', onClick: () => handleUrlSubmitRef.current(url) },
      duration: 8000,
    });
  }, []), preferences.clipboardWatchEnabled);

  const handleUrlSubmit = useCallback(async (url: string) => {
    setParseError(null);
    // Skip an exact re-add of something already downloading; warn (but allow) a
    // re-download of something already in history.
    const dup = findDuplicate(url, queueItems, historyItems);
    if (dup === 'queue') { toast.warning('That’s already in your queue'); return; }
    if (dup === 'completed') { toast.info('You’ve downloaded this before — fetching again'); }
    // Direct file links (disk images, archives, documents) skip yt-dlp and go
    // straight to the queue.
    if (isDirectFileUrl(url)) {
      const item = buildDirectItem(
        url,
        preferences.defaultSaveFolder,
        preferences.bandwidthLimit > 0 ? preferences.bandwidthLimit * 1024 * 1024 : undefined,
      );
      addToQueue(item);
      toast.success(`Added ${item.metadata.title}`);
      return;
    }
    // Torrents skip yt-dlp entirely. Fetch the file list first so the user can
    // pick which files to download, then queue on confirm.
    if (isTorrentUrl(url)) {
      const parseId = ++torrentParseIdRef.current;
      setTorrentUrl(url);
      setTorrentFiles(null); // loading
      // Defer the open past the current Enter/click event — opening a Radix
      // dialog synchronously in the same event lets its dismiss layer catch the
      // trailing interaction and close it instantly.
      setTimeout(() => setShowTorrentModal(true), 0);
      service.parseTorrent(url, preferences.defaultSaveFolder)
        .then(files => { if (torrentParseIdRef.current === parseId) setTorrentFiles(files); })
        .catch((err) => {
          if (torrentParseIdRef.current !== parseId) return; // superseded — ignore
          setShowTorrentModal(false);
          toast.error(typeof err === 'string' ? err : (err?.message || 'Could not read torrent'));
        });
      return;
    }
    // Ambiguous watch-page URL that also names a playlist: ask before parsing.
    // Both answers re-enter this handler with an unambiguous URL (a bare watch
    // URL or a /playlist URL), so neither can re-trigger the prompt.
    const ambiguous = watchWithListInfo(url);
    if (ambiguous) {
      setListChoice(ambiguous);
      return;
    }
    // Pre-select this site's last-used quality preset before the details modal opens.
    const host = siteKey(url);
    const rememberedId = host ? preferences.perSitePresets[host] : undefined;
    if (rememberedId) {
      const remembered = DEFAULT_PRESETS.find(p => p.id === rememberedId);
      if (remembered) setSelectedPreset(remembered);
    }
    setIsParsing(true);
    try {
      lastParsedUrlRef.current = url;
      // One lookup says whether this is a video or a list (a playlist, a
      // channel, an album…) — no guessing from the URL.
      const target = mixVideoUrl(url) ?? url;
      let found = await service.inspectUrl(target);
      if (found.kind === 'playlist') {
        const { entries } = found.playlist;
        if (entries.length > 1) {
          setParsedPlaylist(found.playlist);
          setShowPlaylistModal(true);
          return;
        }
        if (entries.length === 0) {
          setParseError({ message: 'That list has no videos Prism can download' });
          return;
        }
        // A list of one is that one video.
        found = await service.inspectUrl(entries[0].url);
        if (found.kind !== 'video') {
          setParseError({ message: 'Couldn’t read that link' });
          return;
        }
      }
      const { metadata } = found;
      // The same video under a URL the check above didn't recognise: now the
      // lookup has named it (extractor + the site's own id), ask again.
      if (dup === null) {
        const again = findMediaDuplicate(metadata.mediaKey, queueItems, historyItems);
        if (again === 'queue') { toast.warning('That’s already in your queue'); return; }
        if (again === 'completed') toast.info('You’ve downloaded this before — fetching again');
      }
      setParsedMetadata(metadata);
      setShowMediaModal(true);
    } catch (err: unknown) {
      // Tauri commands reject with a structured EngineError; the web demo throws Errors.
      setParseError(errorText(err, 'Failed to parse URL'));
    } finally {
      setIsParsing(false);
    }
  }, [service, preferences.defaultSaveFolder, preferences.perSitePresets, preferences.bandwidthLimit, queueItems, historyItems, addToQueue]);
  handleUrlSubmitRef.current = handleUrlSubmit;

  // yt-dlp couldn't read the link, but it may still be a plain file.
  const downloadAsFile = useCallback(async (url: string) => {
    try {
      const probe = await service.probeDirectLink(url);
      if (probe.contentType?.toLowerCase().startsWith('text/html')) {
        toast.error('That link opens a web page, not a file');
        return;
      }
      setParseError(null);
      const item = buildDirectItem(
        url,
        preferences.defaultSaveFolder,
        preferences.bandwidthLimit > 0 ? preferences.bandwidthLimit * 1024 * 1024 : undefined,
        probe.filename,
      );
      if (probe.size) item.totalBytes = probe.size;
      addToQueue(item);
      toast.success(`Added ${item.metadata.title}`);
    } catch (err) {
      toast.error(errorText(err, 'Could not read that link').message);
    }
  }, [service, preferences.defaultSaveFolder, preferences.bandwidthLimit, addToQueue]);

  const handleBatchSubmit = useCallback(async (urls: string[]) => {
    setParseError(null);
    setBatchProgress({ total: urls.length, done: 0 });
    abortBulkRef.current = false;

    const speedLimitBytes = preferences.bandwidthLimit > 0
      ? preferences.bandwidthLimit * 1024 * 1024
      : 0;

    const added: DownloadItem[] = [];
    let skipped = 0;
    let failed = 0;
    // Look links up four at a time, ahead of the loop below, which still adds
    // them in the order they were given. One at a time, each paying yt-dlp's
    // start-up, a long batch took many minutes.
    const limit = createLimiter(BATCH_LOOKUPS);
    const lookups = new Map<number, Promise<InspectResult>>();
    urls.forEach((url, i) => {
      if (isTorrentUrl(url) || isDirectFileUrl(url) || findDuplicate(url, queueItems, []) === 'queue') return;
      const lookup = limit(() => abortBulkRef.current
        ? Promise.reject(new Error('Stopped'))
        : service.inspectUrl(mixVideoUrl(url) ?? url));
      lookup.catch(() => { /* reported when the loop reaches it */ });
      lookups.set(i, lookup);
    });
    for (let i = 0; i < urls.length; i++) {
      if (abortBulkRef.current) break;
      try {
        // Skip anything already downloading — including earlier entries in this
        // same batch (queueItems state hasn't re-rendered mid-loop).
        if (findDuplicate(urls[i], [...queueItems, ...added], []) === 'queue') {
          skipped++;
          setBatchProgress({ total: urls.length, done: i + 1 });
          continue;
        }
        if (isTorrentUrl(urls[i])) {
          const t = buildTorrentItem(urls[i], preferences.defaultSaveFolder);
          added.push(t);
          addToQueue(t);
          setBatchProgress({ total: urls.length, done: i + 1 });
          continue;
        }
        if (isDirectFileUrl(urls[i])) {
          const d = buildDirectItem(urls[i], preferences.defaultSaveFolder, speedLimitBytes || undefined);
          added.push(d);
          addToQueue(d);
          setBatchProgress({ total: urls.length, done: i + 1 });
          continue;
        }
        const found = await (lookups.get(i) ?? service.inspectUrl(mixVideoUrl(urls[i]) ?? urls[i]));
        if (found.kind === 'playlist') {
          // A list in a batch: every entry, as if chosen in the list dialog.
          const listFormat = presetToFormat(selectedPreset);
          for (const entry of found.playlist.entries) {
            if (findDuplicate(entry.url, [...queueItems, ...added], []) === 'queue') {
              skipped++;
              continue;
            }
            const item = playlistEntryItem(entry, listFormat, preferences.defaultSaveFolder, preferences.defaultRetryCount, speedLimitBytes || undefined);
            added.push(item);
            addToQueue(item);
          }
          setBatchProgress({ total: urls.length, done: i + 1 });
          continue;
        }
        const { metadata } = found;
        // Two URLs for the same video, one of them already queued (or earlier
        // in this batch): the lookup's mediaKey says so where the URLs don't.
        if (findMediaDuplicate(metadata.mediaKey, [...queueItems, ...added], []) === 'queue') {
          skipped++;
          setBatchProgress({ total: urls.length, done: i + 1 });
          continue;
        }
        const format = pickFormatForPreset(metadata.formats, selectedPreset) || metadata.formats[0];
        const item: DownloadItem = {
          id: generateId(),
          metadata,
          settings: {
            format,
            destination: preferences.defaultSaveFolder,
            filename: sanitizeFilename(metadata.title),
            retryCount: preferences.defaultRetryCount,
            startImmediately: true,
            speedLimit: speedLimitBytes || undefined,
          },
          status: 'queued',
          progress: 0,
          speed: 0,
          eta: 0,
          downloadedBytes: 0,
          totalBytes: format?.fileSize || 500_000_000,
          retryAttempt: 0,
        };
        added.push(item);
        addToQueue(item);
      } catch {
        failed++;
      }
      setBatchProgress({ total: urls.length, done: i + 1 });
    }

    setBatchProgress(null);
    const parts = [`${added.length} added`];
    if (skipped > 0) parts.push(`${skipped} already in queue`);
    if (failed > 0) parts.push(`${failed} failed to parse`);
    if (abortBulkRef.current) parts.push('stopped early');
    (failed > 0 ? toast.warning : toast.info)(parts.join(' · '));
  }, [addToQueue, service, preferences.bandwidthLimit, preferences.defaultSaveFolder, preferences.defaultRetryCount, selectedPreset, queueItems]);

  const handleAddToQueue = useCallback((item: DownloadItem) => {
    addToQueue(item);
    setParsedMetadata(null);
    toast.success(`Added to queue: ${item.metadata.title}`, {
      action: { label: 'View queue', onClick: () => navigate('/queue') },
    });
    // Remember this site's quality preset for next time. Key through siteKey so
    // the read path (raw input URL) and write path (yt-dlp's webpage_url_domain)
    // agree on the same normalized host.
    const host = siteKey(item.metadata.source.domain);
    if (host && !item.settings.audioOnly && item.kind !== 'torrent') {
      updatePreference('perSitePresets', { ...preferences.perSitePresets, [host]: selectedPreset.id });
    }
  }, [addToQueue, updatePreference, preferences.perSitePresets, selectedPreset.id, navigate]);

  const handleTorrentConfirm = useCallback((indices: number[]) => {
    // All files selected → leave selectedFiles undefined (download everything).
    const allSelected = torrentFiles ? indices.length === torrentFiles.length : true;
    const item = buildTorrentItem(torrentUrl, preferences.defaultSaveFolder, allSelected ? undefined : indices);
    addToQueue(item);
    toast.success(`Added torrent: ${item.metadata.title}`);
    torrentParseIdRef.current++; // invalidate any in-flight parse
    setShowTorrentModal(false);
    setTorrentFiles(null);
    setTorrentUrl('');
  }, [torrentUrl, torrentFiles, preferences.defaultSaveFolder, addToQueue]);

  // Queue playlist entries instantly from the flat-parse data (title, duration,
  // thumbnail are already known). No per-video yt-dlp round-trips — the selected
  // preset becomes a synthesized format filter, and each item resolves the rest
  // when its download starts. A 100-video playlist queues in one click.
  const handlePlaylistQueue = useCallback((entries: PlaylistEntry[]) => {
    const speedLimitBytes = preferences.bandwidthLimit > 0
      ? preferences.bandwidthLimit * 1024 * 1024
      : 0;
    const format = presetToFormat(selectedPreset);

    for (const entry of entries) {
      addToQueue(playlistEntryItem(entry, format, preferences.defaultSaveFolder, preferences.defaultRetryCount, speedLimitBytes || undefined));
    }

    setShowPlaylistModal(false);
    setParsedPlaylist(null);
    toast.success(`${entries.length} video${entries.length !== 1 ? 's' : ''} added to queue`);
    navigate('/queue');
  }, [addToQueue, preferences.bandwidthLimit, preferences.defaultSaveFolder, preferences.defaultRetryCount, selectedPreset, navigate]);

  handleBatchSubmitRef.current = handleBatchSubmit;

  return (
    <div className="page-container max-w-3xl mx-auto">
      <div className="page-header text-center">
        <h2 className="page-title">Dashboard</h2>
        <p className="page-subtitle">Paste a video URL or magnet link to get started</p>
      </div>

      {/* URL Input */}
      <UrlInput
        onSubmit={handleUrlSubmit}
        onBatchSubmit={handleBatchSubmit}
        isLoading={isParsing}
        error={parseProblem?.message ?? null}
        errorHint={parseProblem?.suggestion}
        errorAction={parseProblem?.action === 'cookies'
          ? { label: 'Set browser cookies', onClick: () => navigate(COOKIES_SETTINGS_PATH) }
          : parseProblem?.action === 'engine'
            ? { label: 'Update engine', onClick: () => navigate(ENGINE_SETTINGS_PATH) }
            : parseError?.engineCode === 'unsupported' && lastParsedUrlRef.current
              ? { label: 'Download as a file', onClick: () => void downloadAsFile(lastParsedUrlRef.current) }
              : parseProblem?.action === 'retry' && lastParsedUrlRef.current
                ? { label: 'Retry', onClick: () => handleUrlSubmit(lastParsedUrlRef.current) }
                : undefined}
        onErrorClear={() => setParseError(null)}
      />

      {/* First-run setup: destination, ffmpeg, cookies. Dismissible. */}
      <SetupCard />

      <QuietHoursBanner className="mt-3" />

      {/* Batch progress indicator */}
      {batchProgress && (
        <div className="mt-3 flex items-center gap-3 px-4 py-2.5 rounded-xl bg-primary/8 border border-primary/20 animate-fade-in">
          <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-foreground">
              Parsing batch… {batchProgress.done} / {batchProgress.total}
            </p>
            <div className="mt-1.5 w-full h-1 rounded-full bg-secondary overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                style={{ width: `${(batchProgress.done / batchProgress.total) * 100}%` }}
              />
            </div>
          </div>
          <button
            onClick={() => { abortBulkRef.current = true; }}
            className="shrink-0 px-2.5 py-1 rounded-md text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors active:scale-[0.97]"
          >
            Stop
          </button>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mt-6">
        <StatTile icon={ArrowDownToLine} value={String(activeDownloads.length)} label="Active" delay={40} />
        <StatTile icon={Gauge} value={totalSpeed > 0 ? formatSpeed(totalSpeed) : '—'} label="Current speed" delay={70} />
        <StatTile icon={CheckCircle2} value={String(completedHistory.length)} label="Completed" delay={100} />
        <StatTile icon={HardDrive} value={totalDownloadedBytes > 0 ? formatBytes(totalDownloadedBytes) : '—'} label="Total downloaded" delay={130} />
      </div>

      <div className="grid grid-cols-2 gap-4 mt-4">
        {/* Quick Presets */}
        <Panel title="Quick Presets" className="animate-fade-in" style={{ animationDelay: '100ms' } as React.CSSProperties}>
          <div className="flex flex-wrap gap-1.5">
            {DEFAULT_PRESETS.map(preset => (
              <button
                key={preset.id}
                onClick={() => setSelectedPreset(preset)}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors active:scale-[0.97]',
                  selectedPreset.id === preset.id
                    ? 'bg-primary/15 text-primary border border-primary/30'
                    : 'bg-secondary/60 text-secondary-foreground hover:bg-secondary border border-transparent'
                )}
              >
                <Sparkles className="w-3 h-3" />
                {preset.name}
              </button>
            ))}
          </div>
        </Panel>

        {/* Queue Snapshot */}
        <Panel title="Active Queue" className="animate-fade-in" style={{ animationDelay: '160ms' } as React.CSSProperties}>
          {activeDownloads.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 py-2">No active downloads</p>
          ) : (
            <div className="space-y-2">
              {activeDownloads.slice(0, 3).map(item => (
                <div key={item.id} className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-foreground truncate">{item.metadata.title}</p>
                    <ProgressBar value={item.progress} className="mt-1" />
                  </div>
                  <span className="text-[11px] tabular-nums text-muted-foreground shrink-0">
                    {item.progress.toFixed(0)}%
                  </span>
                </div>
              ))}
              {activeDownloads.length > 3 && (
                <p className="text-[11px] text-muted-foreground">+{activeDownloads.length - 3} more</p>
              )}
            </div>
          )}
        </Panel>
      </div>

      {/* Recent Downloads */}
      {recentDownloads.length > 0 && (
        <Panel title="Recent Downloads" className="mt-4 animate-fade-in" style={{ animationDelay: '200ms' } as React.CSSProperties}>
          <div className="space-y-1">
            {recentDownloads.map(item => (
              <div key={item.id} className="flex items-center gap-3 py-1.5 group">
                <Thumb
                  src={item.metadata.thumbnail}
                  className="w-16 h-9"
                  fallbackIcon={<CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground" />}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-medium text-foreground truncate">{item.metadata.title}</p>
                  <p className="text-[11px] text-muted-foreground tabular-nums">
                    {formatBytes(item.fileSize)} · {new Date(item.completedAt).toLocaleDateString()}
                  </p>
                </div>
                {item.filePath && (
                  <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => service.openFile(item.filePath!).catch((e) => toast.error(e instanceof Error ? e.message : String(e)))}
                      title="Play"
                      aria-label="Play"
                      className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                    >
                      <Play className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => service.showInFolder(item.filePath!).catch(() => toast.error('File not found — it may have been moved or deleted'))}
                      title="Show in folder"
                      aria-label="Show in folder"
                      className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* RainaCorp Branding */}
      <OutboundLink
        href="https://www.rainacorp.co.uk"
        className="mt-10 mb-2 flex flex-col items-center gap-2.5 py-5 group animate-fade-in"
        style={{ animationDelay: '220ms' } as React.CSSProperties}
      >
        <img src="/rainacorp-logo.webp" alt="RainaCorp" className="w-10 h-10 object-contain opacity-60 group-hover:opacity-90 transition-opacity" />
        <div className="text-center">
          <p className="text-[11px] font-semibold tracking-wide text-muted-foreground/70 group-hover:text-muted-foreground transition-colors">
            A RAINACORP PRODUCT
          </p>
          <p className="text-[11px] text-muted-foreground/40 mt-0.5">rainacorp.co.uk</p>
        </div>
      </OutboundLink>

      {/* Media Details Modal */}
      <MediaDetailsModal
        open={showMediaModal}
        onClose={() => setShowMediaModal(false)}
        metadata={parsedMetadata}
        onAddToQueue={handleAddToQueue}
        preferredResolution={selectedPreset.resolution}
      />

      {/* Playlist Modal */}
      <PlaylistModal
        open={showPlaylistModal}
        onClose={() => { setShowPlaylistModal(false); setParsedPlaylist(null); }}
        playlist={parsedPlaylist}
        onQueueSelected={handlePlaylistQueue}
      />

      {/* Video-or-playlist choice for ambiguous watch?v=…&list=… links */}
      <Dialog open={!!listChoice} onOpenChange={(open) => { if (!open) setListChoice(null); }}>
        <DialogContent className="glass-strong max-w-sm border-border/40 bg-card/95">
          <DialogHeader>
            <DialogTitle className="text-base">This link is part of a playlist</DialogTitle>
            <DialogDescription className="text-xs">
              Download just this video, or import the whole playlist?
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 pt-1">
            <button
              onClick={() => {
                const target = listChoice!.videoUrl;
                setListChoice(null);
                handleUrlSubmitRef.current(target);
              }}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-primary text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.98]"
            >
              <Film className="w-3.5 h-3.5" /> Just this video
            </button>
            <button
              onClick={() => {
                const target = listChoice!.playlistUrl;
                setListChoice(null);
                handleUrlSubmitRef.current(target);
              }}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.98]"
            >
              <ListMusic className="w-3.5 h-3.5" /> Whole playlist
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmation for links opened from outside Prism (S-6). "Ignore" is
          first so it takes initial focus — Enter never adds by accident. */}
      <Dialog open={!!pendingExternalLink} onOpenChange={(open) => { if (!open) settleExternalLink(false); }}>
        <DialogContent className="glass-strong max-w-md border-border/40 bg-card/95">
          <DialogHeader>
            <DialogTitle className="text-base">
              {pendingExternalLink && isTorrentUrl(pendingExternalLink) ? 'Add this torrent?' : 'Download from this link?'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              A web page or another app sent this to Prism. Nothing is fetched until you choose Add.
            </DialogDescription>
          </DialogHeader>
          {pendingExternalLink && (
            <div className="space-y-1.5 min-w-0">
              <p className="text-xs font-medium text-foreground truncate">{describeExternalLink(pendingExternalLink)}</p>
              <p className="max-h-24 overflow-auto rounded-md bg-secondary/60 px-2.5 py-2 font-mono text-[11px] text-muted-foreground break-all">
                {pendingExternalLink}
              </p>
              {externalLinks.length > 1 && (
                <p className="text-[11px] text-muted-foreground">{externalLinks.length - 1} more waiting</p>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => settleExternalLink(false)}
              className="px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
            >
              Ignore
            </button>
            <button
              onClick={() => settleExternalLink(true)}
              className="px-3 py-1.5 rounded-lg bg-primary text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]"
            >
              Add
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Torrent file picker */}
      <TorrentFilesModal
        open={showTorrentModal}
        onClose={() => { torrentParseIdRef.current++; setShowTorrentModal(false); setTorrentFiles(null); setTorrentUrl(''); }}
        title={torrentDisplayName(torrentUrl)}
        files={torrentFiles}
        onConfirm={handleTorrentConfirm}
      />
    </div>
  );
}
