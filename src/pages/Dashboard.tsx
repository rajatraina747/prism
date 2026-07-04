import React, { useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueue, useHistory, useSettings } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { toast } from 'sonner';
import { UrlInput } from '@/components/dashboard/UrlInput';
import { MediaDetailsModal } from '@/components/media-details/MediaDetailsModal';
import { PlaylistModal } from '@/components/media-details/PlaylistModal';
import { TorrentFilesModal } from '@/components/media-details/TorrentFilesModal';
import { Panel, ProgressBar, Thumb } from '@/components/common';
import { DEFAULT_PRESETS, type MediaMetadata, type DownloadItem, type DownloadPreset, type FormatOption, type PlaylistInfo, type PlaylistEntry, type TorrentFileEntry } from '@/types/models';
import { generateId, formatBytes, formatSpeed, isTorrentUrl, torrentDisplayName, sourceKey } from '@/services';
import type { DownloadStatus, HistoryItem } from '@/types/models';
import { useClipboardWatcher } from '@/hooks/use-clipboard-watcher';
import { consumeDeepLinks } from '@/lib/deep-link-bus';
import { cn } from '@/lib/utils';
import {
  Sparkles, Loader2, ArrowDownToLine, Gauge, CheckCircle2, HardDrive, Play, FolderOpen,
} from 'lucide-react';

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
        <p className="text-[10px] text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

/** Pick the format that best matches a preset's target resolution. */
function pickFormatForPreset(formats: FormatOption[], preset: DownloadPreset): FormatOption | undefined {
  if (preset.resolution === 'Best') return formats[0]; // formats are sorted descending
  return formats.find(f => f.resolution === preset.resolution) || formats[0];
}

/** Build a queue item for a magnet/.torrent source. Skips yt-dlp parsing —
 * librqbit resolves the real name/size once peers deliver the metadata. */
function buildTorrentItem(url: string, destination: string, selectedFiles?: number[]): DownloadItem {
  const title = torrentDisplayName(url);
  let domain = 'torrent';
  try { domain = new URL(url).hostname || 'magnet'; } catch { /* magnet has no host */ }
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
      selectedFiles,
    },
    status: 'queued',
    progress: 0,
    speed: 0,
    eta: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    retryAttempt: 0,
    kind: 'torrent',
  };
}

const ACTIVE_STATUSES: DownloadStatus[] = ['queued', 'parsing', 'ready', 'downloading', 'seeding', 'paused'];

/** Hostname of a URL, or null for magnets/invalid input. */
function hostOf(url: string): string | null {
  try { return new URL(url).hostname || null; } catch { return null; }
}

/** Is this source already in the active queue or completed history? */
function findDuplicate(url: string, queue: DownloadItem[], history: HistoryItem[]): 'queue' | 'completed' | null {
  const key = sourceKey(url);
  if (queue.some(i => ACTIVE_STATUSES.includes(i.status) && sourceKey(i.metadata.source.url) === key)) return 'queue';
  if (history.some(i => i.status === 'completed' && sourceKey(i.metadata.source.url) === key)) return 'completed';
  return null;
}

/** Detect if a URL looks like a playlist (heuristic). */
function looksLikePlaylist(url: string): boolean {
  try {
    const u = new URL(url);
    // YouTube playlist
    if (u.hostname.includes('youtube') || u.hostname.includes('youtu.be')) {
      if (u.pathname === '/playlist' || u.searchParams.has('list')) return true;
    }
    // Other common patterns
    if (u.pathname.includes('/playlist') || u.pathname.includes('/sets/')) return true;
  } catch { /* not a valid URL, continue */ }
  return false;
}

export default function Dashboard() {
  const { items: queueItems, addToQueue } = useQueue();
  const { items: historyItems } = useHistory();
  const { preferences, updatePreference } = useSettings();
  const service = useService();
  const navigate = useNavigate();
  const [parseError, setParseError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parsedMetadata, setParsedMetadata] = useState<MediaMetadata | null>(null);
  const [showMediaModal, setShowMediaModal] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ total: number; done: number } | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<DownloadPreset>(DEFAULT_PRESETS[2]); // Full HD default

  // Playlist state
  const [parsedPlaylist, setParsedPlaylist] = useState<PlaylistInfo | null>(null);
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);
  const [playlistProcessing, setPlaylistProcessing] = useState(false);
  const [playlistProcessedCount, setPlaylistProcessedCount] = useState(0);

  // Torrent file-picker state
  const [showTorrentModal, setShowTorrentModal] = useState(false);
  const [torrentUrl, setTorrentUrl] = useState<string>('');
  const [torrentFiles, setTorrentFiles] = useState<TorrentFileEntry[] | null>(null); // null = loading

  const activeDownloads = useMemo(() => queueItems.filter(i => i.status === 'downloading'), [queueItems]);
  const totalSpeed = useMemo(() => activeDownloads.reduce((s, i) => s + (i.speed || 0), 0), [activeDownloads]);
  const completedHistory = useMemo(() => historyItems.filter(i => i.status === 'completed'), [historyItems]);
  const totalDownloadedBytes = useMemo(() => completedHistory.reduce((s, i) => s + (i.fileSize || 0), 0), [completedHistory]);
  const recentDownloads = useMemo(() => completedHistory.slice(0, 3), [completedHistory]);

  // Ref indirection so the clipboard watcher callback stays stable
  const handleUrlSubmitRef = useRef<(url: string) => void>(() => {});
  // Monotonic token so a slow parseTorrent (up to ~45s) can't populate or close a
  // modal the user has since moved on from. Bumped on new parse / close / confirm.
  const torrentParseIdRef = useRef(0);

  // prism://add?url=... deep links (bookmarklet / "send to Prism"), buffered
  // by AppShell so links arriving on other pages aren't lost
  React.useEffect(() => consumeDeepLinks((url) => {
    toast.info('Link received');
    handleUrlSubmitRef.current(url);
  }), []);

  // Offer to fetch video URLs found on the clipboard when the app regains focus
  useClipboardWatcher(useCallback((url: string) => {
    toast('Video link on clipboard', {
      description: url,
      action: { label: 'Fetch', onClick: () => handleUrlSubmitRef.current(url) },
      duration: 8000,
    });
  }, []));

  const handleUrlSubmit = useCallback(async (url: string) => {
    setParseError(null);
    // Skip an exact re-add of something already downloading; warn (but allow) a
    // re-download of something already in history.
    const dup = findDuplicate(url, queueItems, historyItems);
    if (dup === 'queue') { toast.warning('That’s already in your queue'); return; }
    if (dup === 'completed') { toast.info('You’ve downloaded this before — fetching again'); }
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
    // Pre-select this site's last-used quality preset before the details modal opens.
    const host = hostOf(url);
    const rememberedId = host ? preferences.perSitePresets[host] : undefined;
    if (rememberedId) {
      const remembered = DEFAULT_PRESETS.find(p => p.id === rememberedId);
      if (remembered) setSelectedPreset(remembered);
    }
    setIsParsing(true);
    try {
      // Check if it looks like a playlist
      if (looksLikePlaylist(url)) {
        try {
          const playlist = await service.parsePlaylist(url);
          if (playlist.entries.length > 1) {
            setParsedPlaylist(playlist);
            setShowPlaylistModal(true);
            setIsParsing(false);
            return;
          }
          // Single-entry "playlist" — fall through to single parse
        } catch {
          // Not a playlist or failed — fall through to single parse
        }
      }

      const metadata = await service.parseUrl(url);
      setParsedMetadata(metadata);
      setShowMediaModal(true);
    } catch (err: any) {
      setParseError(typeof err === 'string' ? err : (err?.message || 'Failed to parse URL'));
    } finally {
      setIsParsing(false);
    }
  }, [service, addToQueue, preferences.defaultSaveFolder, preferences.perSitePresets, queueItems, historyItems]);
  handleUrlSubmitRef.current = handleUrlSubmit;

  const handleBatchSubmit = useCallback(async (urls: string[]) => {
    setParseError(null);
    setBatchProgress({ total: urls.length, done: 0 });

    const speedLimitBytes = preferences.bandwidthLimit > 0
      ? preferences.bandwidthLimit * 1024 * 1024
      : 0;

    const added: DownloadItem[] = [];
    let skipped = 0;
    for (let i = 0; i < urls.length; i++) {
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
        const metadata = await service.parseUrl(urls[i]);
        const format = pickFormatForPreset(metadata.formats, selectedPreset) || metadata.formats[0];
        const item: DownloadItem = {
          id: generateId(),
          metadata,
          settings: {
            format,
            destination: preferences.defaultSaveFolder,
            filename: metadata.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_'),
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
        // Skip failed URLs in batch
      }
      setBatchProgress({ total: urls.length, done: i + 1 });
    }

    setBatchProgress(null);
    if (skipped > 0) toast.info(`Skipped ${skipped} already in your queue`);
  }, [addToQueue, service, preferences.bandwidthLimit, preferences.defaultSaveFolder, preferences.defaultRetryCount, selectedPreset, queueItems]);

  const handleAddToQueue = useCallback((item: DownloadItem) => {
    addToQueue(item);
    setParsedMetadata(null);
    // Remember this site's quality preset for next time.
    const host = item.metadata.source.domain;
    if (host && !item.settings.audioOnly && item.kind !== 'torrent') {
      updatePreference('perSitePresets', { ...preferences.perSitePresets, [host]: selectedPreset.id });
    }
  }, [addToQueue, updatePreference, preferences.perSitePresets, selectedPreset.id]);

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

  const handlePlaylistQueue = useCallback(async (entries: PlaylistEntry[]) => {
    setPlaylistProcessing(true);
    setPlaylistProcessedCount(0);

    const speedLimitBytes = preferences.bandwidthLimit > 0
      ? preferences.bandwidthLimit * 1024 * 1024
      : 0;

    let queued = 0;
    for (let i = 0; i < entries.length; i++) {
      try {
        const metadata = await service.parseUrl(entries[i].url);
        const format = pickFormatForPreset(metadata.formats, selectedPreset) || metadata.formats[0];
        const item: DownloadItem = {
          id: generateId(),
          metadata,
          settings: {
            format,
            destination: preferences.defaultSaveFolder,
            filename: metadata.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_'),
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
        addToQueue(item);
        queued++;
      } catch {
        // Skip entries that fail to parse
      }
      setPlaylistProcessedCount(i + 1);
    }

    setPlaylistProcessing(false);
    setShowPlaylistModal(false);
    setParsedPlaylist(null);
    setPlaylistProcessedCount(0);

    if (queued > 0) {
      toast.success(`${queued} video${queued !== 1 ? 's' : ''} added to queue`);
      navigate('/queue');
    } else {
      toast.error('Failed to queue any videos');
    }
  }, [addToQueue, service, preferences.bandwidthLimit, selectedPreset, navigate]);

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
        error={parseError}
      />

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
                  <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">
                    {item.progress.toFixed(0)}%
                  </span>
                </div>
              ))}
              {activeDownloads.length > 3 && (
                <p className="text-[10px] text-muted-foreground">+{activeDownloads.length - 3} more</p>
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
                  <p className="text-[10px] text-muted-foreground tabular-nums">
                    {formatBytes(item.fileSize)} · {new Date(item.completedAt).toLocaleDateString()}
                  </p>
                </div>
                {item.filePath && (
                  <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => service.openFile(item.filePath!).catch(() => toast.error('File not found — it may have been moved or deleted'))}
                      title="Play"
                      className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                    >
                      <Play className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => service.showInFolder(item.filePath!).catch(() => toast.error('File not found — it may have been moved or deleted'))}
                      title="Show in folder"
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
      <a
        href="https://www.rainacorp.co.uk"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-10 mb-2 flex flex-col items-center gap-2.5 py-5 group animate-fade-in"
        style={{ animationDelay: '220ms' } as React.CSSProperties}
      >
        <img src="/rainacorp-logo.png" alt="RainaCorp" className="w-10 h-10 object-contain opacity-60 group-hover:opacity-90 transition-opacity" />
        <div className="text-center">
          <p className="text-[11px] font-semibold tracking-wide text-muted-foreground/70 group-hover:text-muted-foreground transition-colors">
            A RAINACORP PRODUCT
          </p>
          <p className="text-[10px] text-muted-foreground/40 mt-0.5">rainacorp.co.uk</p>
        </div>
      </a>

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
        isProcessing={playlistProcessing}
        processedCount={playlistProcessedCount}
      />

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
