import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { MediaMetadata, DownloadItem, FormatOption } from '@/types/models';
import { generateId, formatBytes, formatDuration, sanitizeFilename } from '@/services';
import { DEFAULT_PREFERENCES } from '@/types/models';
import { useSettings } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { cn } from '@/lib/utils';
import { Thumb } from '@/components/common';
import {
  Clock, Film, User, ChevronDown, ChevronUp,
  FolderOpen, FileText, Music, Subtitles,
} from 'lucide-react';

const SUBTITLE_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hi', label: 'Hindi' },
  { value: 'it', label: 'Italian' },
  { value: 'ru', label: 'Russian' },
];

interface MediaDetailsModalProps {
  open: boolean;
  onClose: () => void;
  metadata: MediaMetadata | null;
  onAddToQueue: (item: DownloadItem) => void;
  preferredResolution?: string;
}

export function MediaDetailsModal({ open, onClose, metadata, onAddToQueue, preferredResolution }: MediaDetailsModalProps) {
  const { preferences } = useSettings();
  const service = useService();
  const [selectedFormat, setSelectedFormat] = useState<FormatOption | null>(null);
  const [filename, setFilename] = useState('');
  const [startImmediately, setStartImmediately] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [audioOnly, setAudioOnly] = useState(false);
  const [downloadSubtitles, setDownloadSubtitles] = useState(false);
  const [subtitleLanguage, setSubtitleLanguage] = useState('en');
  // Codes chosen from the uploader's own subtitles, when the site lists them.
  const [subtitleCodes, setSubtitleCodes] = useState<string[]>([]);
  const [embedSubtitles, setEmbedSubtitles] = useState(false);
  // '' = the original track.
  const [audioLanguage, setAudioLanguage] = useState('');
  // Per-download destination override; null = use the Settings default.
  const [destination, setDestination] = useState<string | null>(null);

  React.useEffect(() => {
    if (metadata) {
      setDestination(null);
      let pick: FormatOption | null = null;
      if (preferredResolution && preferredResolution !== 'Best') {
        pick = metadata.formats.find(f => f.resolution === preferredResolution) || null;
      }
      setSelectedFormat(pick || metadata.formats[0] || null);
      setFilename(sanitizeFilename(metadata.title));
      setAudioOnly(false);
      setDownloadSubtitles(false);
      setEmbedSubtitles(false);
      setAudioLanguage('');
      // Start from the uploader's English subtitles when there are any.
      const listed = metadata.subtitleLanguages ?? [];
      const english = listed.find(l => l.code === 'en' || l.code.startsWith('en-'));
      setSubtitleCodes(english ? [english.code] : listed.slice(0, 1).map(l => l.code));
    }
  }, [metadata, preferredResolution]);

  if (!metadata) return null;

  const fileExtension = audioOnly ? preferences.audioFormat : (selectedFormat?.container || 'mp4');
  const listedSubtitles = metadata.subtitleLanguages ?? [];
  const audioTracks = metadata.audioTracks ?? [];

  const handleAdd = () => {
    if (!audioOnly && !selectedFormat) return;
    const speedLimitBytes = preferences.bandwidthLimit > 0
      ? preferences.bandwidthLimit * 1024 * 1024
      : 0;

    const item: DownloadItem = {
      id: generateId(),
      metadata,
      settings: {
        format: audioOnly ? null : selectedFormat,
        destination: destination ?? preferences.defaultSaveFolder,
        filename,
        retryCount: DEFAULT_PREFERENCES.defaultRetryCount,
        startImmediately,
        audioOnly,
        downloadSubtitles: downloadSubtitles && (listedSubtitles.length === 0 || subtitleCodes.length > 0),
        subtitleLanguage: downloadSubtitles
          ? (listedSubtitles.length > 0 ? subtitleCodes.join(',') : subtitleLanguage)
          : undefined,
        embedSubtitles: downloadSubtitles && embedSubtitles && !audioOnly,
        audioLanguage: audioLanguage || undefined,
        speedLimit: speedLimitBytes || undefined,
      },
      status: startImmediately ? 'queued' : 'ready',
      progress: 0,
      speed: 0,
      eta: 0,
      downloadedBytes: 0,
      totalBytes: audioOnly ? 10_000_000 : (selectedFormat?.fileSize || 0),
      retryAttempt: 0,
    };
    onAddToQueue(item);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="glass-strong max-w-lg border-border/40 bg-card/95 p-0 gap-0">
        <DialogHeader className="p-5 pb-0">
          <DialogTitle className="text-base font-semibold text-foreground pr-6 leading-snug">
            {metadata.title}
          </DialogTitle>
        </DialogHeader>

        <div className="p-5 min-w-0 space-y-4">
          {/* Thumbnail + Info */}
          <div className="flex gap-4">
            <Thumb src={metadata.thumbnail} className="w-36 h-20 rounded-lg" />
            <div className="flex-1 space-y-1.5 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5"><Clock className="w-3 h-3" /> {formatDuration(metadata.duration)}</div>
              {metadata.uploader && <div className="flex items-center gap-1.5"><User className="w-3 h-3" /> {metadata.uploader}</div>}
              <div className="flex items-center gap-1.5"><Film className="w-3 h-3" /> {metadata.source.domain}</div>
            </div>
          </div>

          {/* Audio Only Toggle */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAudioOnly(false)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors active:scale-[0.97]',
                !audioOnly
                  ? 'bg-primary/15 text-primary border border-primary/30'
                  : 'bg-secondary/50 text-secondary-foreground hover:bg-secondary border border-transparent'
              )}
            >
              <Film className="w-3 h-3" />
              Video
            </button>
            <button
              onClick={() => setAudioOnly(true)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors active:scale-[0.97]',
                audioOnly
                  ? 'bg-primary/15 text-primary border border-primary/30'
                  : 'bg-secondary/50 text-secondary-foreground hover:bg-secondary border border-transparent'
              )}
            >
              <Music className="w-3 h-3" />
              Audio Only
            </button>
          </div>

          {/* Format Selection — only for video mode */}
          {!audioOnly && (
            <div>
              <label className="panel-header block">Quality & Format</label>
              {/* Cap the list — some sites return a dozen formats, which would
                  otherwise push the dialog (and its Add button) off-screen. */}
              <div className="grid grid-cols-1 gap-1.5 max-h-56 overflow-y-auto pr-1">
                {/* Key/compare by label — labels are unique (the backend de-dupes
                    by label), while ids are yt-dlp filter strings that can
                    collide when two labels resolve to the same height. */}
                {metadata.formats.map(fmt => (
                  <button
                    key={fmt.label}
                    onClick={() => setSelectedFormat(fmt)}
                    className={cn(
                      'flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-colors active:scale-[0.98]',
                      selectedFormat?.label === fmt.label
                        ? 'bg-primary/12 border border-primary/30 text-foreground'
                        : 'bg-secondary/50 border border-transparent text-secondary-foreground hover:bg-secondary'
                    )}
                  >
                    <span className="font-medium">{fmt.label}</span>
                    <span className="flex items-center gap-3 text-muted-foreground">
                      <span>{fmt.resolution}</span>
                      <span className="uppercase">{fmt.container}</span>
                      <span className="tabular-nums">{fmt.fileSize > 0 ? formatBytes(fmt.fileSize) : '—'}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {!audioOnly && selectedFormat?.playsEverywhere === false && (
            <p className="text-[11px] text-muted-foreground -mt-2">
              {selectedFormat.codec} video plays in VLC, IINA and browsers, but not in QuickTime or Photos. Pick an H.264 option for those.
            </p>
          )}

          {/* Audio format info */}
          {audioOnly && (
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-secondary/50 border border-border/30">
              <Music className="w-4 h-4 text-primary" />
              <div>
                <p className="text-xs font-medium text-foreground">{preferences.audioFormat.toUpperCase()} Audio</p>
                <p className="text-[11px] text-muted-foreground">Best quality audio extracted from video · format set in Settings</p>
              </div>
            </div>
          )}

          {/* Filename */}
          <div>
            <label className="panel-header block">Filename</label>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-input border border-border/40">
              <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <input
                type="text"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                className="flex-1 bg-transparent text-xs text-foreground outline-none"
              />
              <span className="text-[11px] text-muted-foreground">.{fileExtension}</span>
            </div>
          </div>

          {/* Subtitles */}
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={downloadSubtitles}
                onChange={(e) => setDownloadSubtitles(e.target.checked)}
                className="rounded border-border"
              />
              <Subtitles className="w-3 h-3 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Download subtitles</span>
            </label>
            {downloadSubtitles && listedSubtitles.length === 0 && (
              <select
                value={subtitleLanguage}
                onChange={e => setSubtitleLanguage(e.target.value)}
                className="px-2 py-1 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none cursor-pointer"
              >
                {SUBTITLE_LANGUAGES.map(l => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            )}
            {downloadSubtitles && !audioOnly && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={embedSubtitles}
                  onChange={(e) => setEmbedSubtitles(e.target.checked)}
                  className="rounded border-border"
                />
                <span className="text-xs text-muted-foreground">Inside the video</span>
              </label>
            )}
          </div>
          {downloadSubtitles && listedSubtitles.length > 0 && (
            // The uploader's own subtitles, several at once.
            <div className="flex flex-wrap gap-1.5 -mt-2 max-h-24 overflow-y-auto">
              {listedSubtitles.map(l => {
                const on = subtitleCodes.includes(l.code);
                return (
                  <button
                    key={l.code}
                    type="button"
                    onClick={() => setSubtitleCodes(codes => on ? codes.filter(c => c !== l.code) : [...codes, l.code])}
                    className={cn(
                      'px-2 py-0.5 rounded-md text-[11px] border transition-colors',
                      on ? 'bg-primary/12 border-primary/30 text-foreground' : 'bg-secondary/50 border-transparent text-muted-foreground hover:bg-secondary',
                    )}
                  >
                    {l.name}
                  </button>
                );
              })}
            </div>
          )}

          {/* Audio track (dubs) */}
          {audioTracks.length > 1 && (
            <div className="flex items-center gap-3">
              <Music className="w-3 h-3 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Audio</span>
              <select
                value={audioLanguage}
                onChange={e => setAudioLanguage(e.target.value)}
                className="px-2 py-1 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none cursor-pointer"
              >
                {audioTracks.map(t => (
                  <option key={t.code} value={t.original ? '' : t.code}>
                    {t.name}{t.original ? ' · original' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Advanced */}
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            Advanced settings
          </button>

          {showAdvanced && (
            <div className="space-y-3 pl-1 animate-fade-in">
              <div>
                <label className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1 block">Destination</label>
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-input border border-border/40">
                  <FolderOpen className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-xs text-muted-foreground">
                    {destination ?? preferences.defaultSaveFolder}
                  </span>
                  <button
                    onClick={async () => {
                      const dir = await service.pickDirectory().catch(() => null);
                      if (dir) setDestination(dir);
                    }}
                    className="shrink-0 px-2 py-1 rounded-md text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors active:scale-[0.97]"
                  >
                    Change…
                  </button>
                </div>
              </div>
              {preferences.bandwidthLimit > 0 && (
                <div className="text-[11px] text-muted-foreground">
                  Speed limited to {preferences.bandwidthLimit} MB/s (from Settings)
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between pt-2 border-t border-border/30">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={startImmediately}
                onChange={(e) => setStartImmediately(e.target.checked)}
                className="rounded border-border"
              />
              <span className="text-xs text-muted-foreground">Start immediately</span>
            </label>

            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
              >
                Cancel
              </button>
              <button
                onClick={handleAdd}
                disabled={!audioOnly && !selectedFormat}
                className="px-4 py-2 rounded-lg bg-primary text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97] disabled:opacity-40"
              >
                Add to Queue
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
