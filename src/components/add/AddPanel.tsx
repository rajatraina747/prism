import React, { useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueue, useHistory, useSettings } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { toast } from 'sonner';
import { UrlInput } from '@/components/dashboard/UrlInput';
import { SetupCard } from '@/components/dashboard/SetupCard';
import { MediaDetailsModal } from '@/components/media-details/MediaDetailsModal';
import { PlaylistModal } from '@/components/media-details/PlaylistModal';
import { TorrentFilesModal } from '@/components/media-details/TorrentFilesModal';
import { qualityFromStored, type DefaultQuality, type MediaMetadata, type DownloadItem, type PlaylistInfo, type PlaylistEntry, type InspectResult, type TorrentFileEntry } from '@/types/models';
import { buildTorrentItem } from '@/stores/torrent-item';
import { findDuplicate, findMediaDuplicate } from '@/stores/dedupe';
import { isTorrentUrl, isDirectFileUrl, isFormatlessLookup, torrentDisplayName, siteKey, sanitizeFilename, mixVideoUrl } from '@/services';
import { useClipboardWatcher } from '@/hooks/use-clipboard-watcher';
import { consumeDeepLinks } from '@/lib/deep-link-bus';
import { createLimiter } from '@/lib/limit';
import { referrerFor } from '@/lib/referrers';
import { COOKIES_SETTINGS_PATH, ENGINE_SETTINGS_PATH } from '@/lib/nav-bus';
import { classifyError, conciseError, errorText, type ErrorText } from '@/services/errors';
import { Loader2, Film, ListMusic } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { buildItem } from '@/stores/build-item';
import { BATCH_LOOKUPS, pickFormatForQuality, qualityToFormat, buildDirectItem, watchWithListInfo, describeExternalLink, playlistEntryItem } from './add-items';

/** Everything that adds things: the link box, the first-run setup card, the
 * batch progress line, and the dialogs a lookup opens (quality, playlist,
 * torrent files, external links). Shown at the top of Downloads; it was the
 * Dashboard until 2.5.1, whose stat tiles, mini queue and recent list only
 * repeated Downloads and the Library. */
export function AddPanel() {
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
  // The quality used when Prism doesn't ask: this site's remembered one while
  // its link is open, else Settings → Default quality.
  const [siteQuality, setSiteQuality] = useState<DefaultQuality | null>(null);
  const quality: DefaultQuality = siteQuality ?? preferences.defaultQuality ?? '1080p';

  // Playlist state
  const [parsedPlaylist, setParsedPlaylist] = useState<PlaylistInfo | null>(null);
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);

  // Torrent file-picker state
  const [showTorrentModal, setShowTorrentModal] = useState(false);
  const [torrentUrl, setTorrentUrl] = useState<string>('');
  const [torrentFiles, setTorrentFiles] = useState<TorrentFileEntry[] | null>(null); // null = loading

  // A watch URL that also names a playlist — ask which the user meant.
  const [listChoice, setListChoice] = useState<{ videoUrl: string; playlistUrl: string } | null>(null);
  // Bumped once something typed in the link box is queued, which clears it.
  const [queuedCount, setQueuedCount] = useState(0);

  // Parse errors get the same treatment as failed downloads: the engine's
  // line, what to do, and the action that can fix it.
  const parseProblem = useMemo(() => {
    if (!parseError) return null;
    const { suggestion, action } = classifyError(parseError.message, parseError.engineCode);
    return { message: conciseError(parseError.message), suggestion, action };
  }, [parseError]);

  // Ref indirection so the clipboard watcher callback stays stable
  const handleUrlSubmitRef = useRef<(url: string) => void>(() => {});
  // Declared below handleUrlSubmit, which needs it for formatless lookups.
  const downloadAsFileRef = useRef<(url: string) => Promise<void>>(async () => {});
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
    // Pre-select the quality last picked on this site before the details modal opens.
    const host = siteKey(url);
    setSiteQuality((host ? qualityFromStored(preferences.perSitePresets[host]) : undefined) ?? null);
    setIsParsing(true);
    try {
      lastParsedUrlRef.current = url;
      // One lookup says whether this is a video or a list (a playlist, a
      // channel, an album…) — no guessing from the URL.
      const target = mixVideoUrl(url) ?? url;
      let found = await service.inspectUrl(target, referrerFor(url));
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
      // A plain file yt-dlp's generic extractor mistook for a video.
      if (isFormatlessLookup(metadata)) {
        await downloadAsFileRef.current(url);
        return;
      }
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
      const probe = await service.probeDirectLink(url, referrerFor(url));
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
  downloadAsFileRef.current = downloadAsFile;

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
        : service.inspectUrl(mixVideoUrl(url) ?? url, referrerFor(url)));
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
          const listFormat = qualityToFormat(quality);
          for (const entry of found.playlist.entries) {
            if (findDuplicate(entry.url, [...queueItems, ...added], []) === 'queue') {
              skipped++;
              continue;
            }
            const item = playlistEntryItem(entry, listFormat, preferences.defaultSaveFolder, speedLimitBytes || undefined);
            added.push(item);
            addToQueue(item);
          }
          setBatchProgress({ total: urls.length, done: i + 1 });
          continue;
        }
        const { metadata } = found;
        // A plain file the generic extractor mistook for a video: queue it as
        // a direct download (a web page is a failure, as in downloadAsFile).
        if (isFormatlessLookup(metadata)) {
          const probe = await service.probeDirectLink(urls[i], referrerFor(urls[i]));
          if (probe.contentType?.toLowerCase().startsWith('text/html')) {
            failed++;
          } else {
            const d = buildDirectItem(urls[i], preferences.defaultSaveFolder, speedLimitBytes || undefined, probe.filename);
            if (probe.size) d.totalBytes = probe.size;
            added.push(d);
            addToQueue(d);
          }
          setBatchProgress({ total: urls.length, done: i + 1 });
          continue;
        }
        // Two URLs for the same video, one of them already queued (or earlier
        // in this batch): the lookup's mediaKey says so where the URLs don't.
        if (findMediaDuplicate(metadata.mediaKey, [...queueItems, ...added], []) === 'queue') {
          skipped++;
          setBatchProgress({ total: urls.length, done: i + 1 });
          continue;
        }
        const format = pickFormatForQuality(metadata.formats, quality) || metadata.formats[0];
        const item = buildItem({
          metadata,
          settings: {
            format,
            destination: preferences.defaultSaveFolder,
            filename: sanitizeFilename(metadata.title),
            speedLimit: speedLimitBytes || undefined,
          },
          totalBytes: format?.fileSize,
        });
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
  }, [addToQueue, service, preferences.bandwidthLimit, preferences.defaultSaveFolder, quality, queueItems]);

  const handleAddToQueue = useCallback((item: DownloadItem) => {
    // The page the link came from, if the extension said (lib/referrers.ts).
    const referer = item.settings.referer ?? referrerFor(lastParsedUrlRef.current) ?? referrerFor(item.metadata.source.url);
    if (referer) item = { ...item, settings: { ...item.settings, referer } };
    addToQueue(item);
    setParsedMetadata(null);
    setQueuedCount(n => n + 1);
    toast.success(`Added to queue: ${item.metadata.title}`, {
      action: { label: 'View queue', onClick: () => navigate('/queue') },
    });
    // Remember the quality picked on this site for next time. Key through
    // siteKey so the read path (raw input URL) and write path (yt-dlp's
    // webpage_url_domain) agree on the same normalized host.
    const host = siteKey(item.metadata.source.domain);
    const picked = qualityFromStored(item.settings.format?.resolution);
    if (host && picked && !item.settings.audioOnly && item.kind !== 'torrent') {
      updatePreference('perSitePresets', { ...preferences.perSitePresets, [host]: picked });
    }
  }, [addToQueue, updatePreference, preferences.perSitePresets, navigate]);

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
    setQueuedCount(n => n + 1);
  }, [torrentUrl, torrentFiles, preferences.defaultSaveFolder, addToQueue]);

  // Queue playlist entries instantly from the flat-parse data (title, duration,
  // thumbnail are already known). No per-video yt-dlp round-trips — the selected
  // preset becomes a synthesized format filter, and each item resolves the rest
  // when its download starts. A 100-video playlist queues in one click.
  const handlePlaylistQueue = useCallback((entries: PlaylistEntry[]) => {
    const speedLimitBytes = preferences.bandwidthLimit > 0
      ? preferences.bandwidthLimit * 1024 * 1024
      : 0;
    const format = qualityToFormat(quality);

    for (const entry of entries) {
      addToQueue(playlistEntryItem(entry, format, preferences.defaultSaveFolder, speedLimitBytes || undefined));
    }

    setShowPlaylistModal(false);
    setQueuedCount(n => n + 1);
    setParsedPlaylist(null);
    toast.success(`${entries.length} video${entries.length !== 1 ? 's' : ''} added to queue`);
    navigate('/queue');
  }, [addToQueue, preferences.bandwidthLimit, preferences.defaultSaveFolder, quality, navigate]);

  handleBatchSubmitRef.current = handleBatchSubmit;

  return (
    <div className="mb-4">

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
        clearSignal={queuedCount}
      />

      {/* First-run setup: destination, ffmpeg, cookies. Dismissible. */}
      <SetupCard />

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
            className="shrink-0 px-2.5 py-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors active:scale-[0.97]"
          >
            Stop
          </button>
        </div>
      )}

      {/* Media Details Modal */}
      <MediaDetailsModal
        open={showMediaModal}
        onClose={() => setShowMediaModal(false)}
        metadata={parsedMetadata}
        onAddToQueue={handleAddToQueue}
        preferredResolution={quality === 'best' ? 'Best' : quality}
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
              <p className="max-h-24 overflow-auto rounded-md bg-secondary/60 px-2.5 py-2 font-mono text-xs text-muted-foreground break-all">
                {pendingExternalLink}
              </p>
              {referrerFor(pendingExternalLink) && (
                // Sent as the Referer with this download: the page said it came
                // from here, so show it (REVIEW 2026-09-28).
                <p className="text-xs text-muted-foreground truncate">
                  From the page: {referrerFor(pendingExternalLink)}
                </p>
              )}
              {externalLinks.length > 1 && (
                <p className="text-xs text-muted-foreground">{externalLinks.length - 1} more waiting</p>
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
        destination={preferences.defaultSaveFolder}
      />
    </div>
  );
}
