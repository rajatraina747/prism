import React, { useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueue, useSettings } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { toast } from 'sonner';
import { UrlInput } from '@/components/dashboard/UrlInput';
import { MediaDetailsModal } from '@/components/media-details/MediaDetailsModal';
import { PlaylistModal } from '@/components/media-details/PlaylistModal';
import { Panel, ProgressBar } from '@/components/common';
import { DEFAULT_PRESETS, type MediaMetadata, type DownloadItem, type DownloadPreset, type FormatOption, type PlaylistInfo, type PlaylistEntry } from '@/types/models';
import { generateId } from '@/services';
import { cn } from '@/lib/utils';
import {
  Sparkles, Loader2,
} from 'lucide-react';

/** Pick the format that best matches a preset's target resolution. */
function pickFormatForPreset(formats: FormatOption[], preset: DownloadPreset): FormatOption | undefined {
  if (preset.resolution === 'Best') return formats[0]; // formats are sorted descending
  return formats.find(f => f.resolution === preset.resolution) || formats[0];
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
  const { preferences } = useSettings();
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

  const activeDownloads = useMemo(() => queueItems.filter(i => i.status === 'downloading'), [queueItems]);

  const handleUrlSubmit = useCallback(async (url: string) => {
    setParseError(null);
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
  }, [service]);

  const handleBatchSubmit = useCallback(async (urls: string[]) => {
    setParseError(null);
    setBatchProgress({ total: urls.length, done: 0 });

    const speedLimitBytes = preferences.bandwidthLimit > 0
      ? preferences.bandwidthLimit * 1024 * 1024
      : 0;

    for (let i = 0; i < urls.length; i++) {
      try {
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
        addToQueue(item);
      } catch {
        // Skip failed URLs in batch
      }
      setBatchProgress({ total: urls.length, done: i + 1 });
    }

    setBatchProgress(null);
  }, [addToQueue, service, preferences.bandwidthLimit, preferences.defaultSaveFolder, preferences.defaultRetryCount, selectedPreset]);

  const handleAddToQueue = useCallback((item: DownloadItem) => {
    addToQueue(item);
    setParsedMetadata(null);
  }, [addToQueue]);

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
        <p className="page-subtitle">Paste a video URL to get started</p>
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

      <div className="grid grid-cols-2 gap-4 mt-6">
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
    </div>
  );
}
