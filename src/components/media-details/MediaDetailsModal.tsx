import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { MediaMetadata, DownloadItem, FormatOption } from '@/types/models';
import { generateId, formatBytes, formatDuration } from '@/services';
import { DEFAULT_PREFERENCES } from '@/types/models';
import { StatusBadge } from '@/components/common';
import { cn } from '@/lib/utils';
import {
  Clock, HardDrive, Film, User, ChevronDown, ChevronUp,
  FolderOpen, FileText, Gauge,
} from 'lucide-react';

interface MediaDetailsModalProps {
  open: boolean;
  onClose: () => void;
  metadata: MediaMetadata | null;
  onAddToQueue: (item: DownloadItem) => void;
}

export function MediaDetailsModal({ open, onClose, metadata, onAddToQueue }: MediaDetailsModalProps) {
  const [selectedFormat, setSelectedFormat] = useState<FormatOption | null>(null);
  const [filename, setFilename] = useState('');
  const [startImmediately, setStartImmediately] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [priority, setPriority] = useState<'high' | 'normal' | 'low'>('normal');

  React.useEffect(() => {
    if (metadata) {
      setSelectedFormat(metadata.formats[1] || metadata.formats[0] || null);
      setFilename(metadata.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_'));
    }
  }, [metadata]);

  if (!metadata) return null;

  const handleAdd = () => {
    if (!selectedFormat) return;
    const item: DownloadItem = {
      id: generateId(),
      metadata,
      settings: {
        format: selectedFormat,
        destination: DEFAULT_PREFERENCES.defaultSaveFolder,
        filename,
        priority,
        retryCount: DEFAULT_PREFERENCES.defaultRetryCount,
        startImmediately,
      },
      status: startImmediately ? 'queued' : 'ready',
      progress: 0,
      speed: 0,
      eta: 0,
      downloadedBytes: 0,
      totalBytes: selectedFormat.fileSize,
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

        <div className="p-5 space-y-4">
          {/* Thumbnail + Info */}
          <div className="flex gap-4">
            <img
              src={metadata.thumbnail}
              alt=""
              className="w-36 h-20 rounded-lg object-cover bg-secondary"
            />
            <div className="flex-1 space-y-1.5 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5"><Clock className="w-3 h-3" /> {formatDuration(metadata.duration)}</div>
              {metadata.uploader && <div className="flex items-center gap-1.5"><User className="w-3 h-3" /> {metadata.uploader}</div>}
              <div className="flex items-center gap-1.5"><Film className="w-3 h-3" /> {metadata.source.domain}</div>
            </div>
          </div>

          {/* Format Selection */}
          <div>
            <label className="panel-header block">Quality & Format</label>
            <div className="grid grid-cols-1 gap-1.5">
              {metadata.formats.map(fmt => (
                <button
                  key={fmt.id}
                  onClick={() => setSelectedFormat(fmt)}
                  className={cn(
                    'flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-colors active:scale-[0.98]',
                    selectedFormat?.id === fmt.id
                      ? 'bg-primary/12 border border-primary/30 text-foreground'
                      : 'bg-secondary/50 border border-transparent text-secondary-foreground hover:bg-secondary'
                  )}
                >
                  <span className="font-medium">{fmt.label}</span>
                  <span className="flex items-center gap-3 text-muted-foreground">
                    <span>{fmt.resolution}</span>
                    <span className="uppercase">{fmt.container}</span>
                    <span className="tabular-nums">{formatBytes(fmt.fileSize)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

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
              <span className="text-[10px] text-muted-foreground">.{selectedFormat?.container || 'mp4'}</span>
            </div>
          </div>

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
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 block">Destination</label>
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-input border border-border/40">
                  <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">{DEFAULT_PREFERENCES.defaultSaveFolder}</span>
                </div>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 block">Priority</label>
                <div className="flex gap-1.5">
                  {(['high', 'normal', 'low'] as const).map(p => (
                    <button
                      key={p}
                      onClick={() => setPriority(p)}
                      className={cn(
                        'px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors active:scale-[0.97]',
                        priority === p ? 'bg-primary/15 text-primary' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                      )}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
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
                disabled={!selectedFormat}
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
