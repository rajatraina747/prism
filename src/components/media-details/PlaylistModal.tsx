import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { PlaylistInfo, PlaylistEntry } from '@/types/models';
import { formatDuration } from '@/services';
import { cn } from '@/lib/utils';
import { ListMusic, Check, Clock } from 'lucide-react';

interface PlaylistModalProps {
  open: boolean;
  onClose: () => void;
  playlist: PlaylistInfo | null;
  onQueueSelected: (entries: PlaylistEntry[]) => void;
  isProcessing: boolean;
  processedCount: number;
}

export function PlaylistModal({ open, onClose, playlist, onQueueSelected, isProcessing, processedCount }: PlaylistModalProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set());

  React.useEffect(() => {
    if (playlist) {
      setSelected(new Set(playlist.entries.map((_, i) => i)));
    }
  }, [playlist]);

  if (!playlist) return null;

  const toggleEntry = (index: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === playlist.entries.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(playlist.entries.map((_, i) => i)));
    }
  };

  const handleQueue = () => {
    const entries = playlist.entries.filter((_, i) => selected.has(i));
    onQueueSelected(entries);
  };

  return (
    <Dialog open={open} onOpenChange={() => { if (!isProcessing) onClose(); }}>
      <DialogContent className="glass-strong max-w-lg border-border/40 bg-card/95 p-0 gap-0">
        <DialogHeader className="p-5 pb-0">
          <div className="flex items-center gap-2">
            <ListMusic className="w-4 h-4 text-primary" />
            <DialogTitle className="text-base font-semibold text-foreground pr-6 leading-snug">
              {playlist.title}
            </DialogTitle>
          </div>
        </DialogHeader>

        <div className="p-5 space-y-4">
          {/* Select all / count */}
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.size === playlist.entries.length}
                onChange={toggleAll}
                className="rounded border-border"
                disabled={isProcessing}
              />
              <span className="text-xs text-muted-foreground">
                Select all ({selected.size}/{playlist.entries.length})
              </span>
            </label>
            {isProcessing && (
              <span className="text-xs text-primary font-medium">
                Processing {processedCount}/{selected.size}...
              </span>
            )}
          </div>

          {/* Entry list */}
          <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
            {playlist.entries.map((entry, i) => (
              <button
                key={i}
                onClick={() => !isProcessing && toggleEntry(i)}
                disabled={isProcessing}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors',
                  selected.has(i)
                    ? 'bg-primary/8 border border-primary/20'
                    : 'bg-secondary/30 border border-transparent hover:bg-secondary/50',
                  isProcessing && 'opacity-60 cursor-not-allowed'
                )}
              >
                <div className={cn(
                  'w-4 h-4 rounded flex items-center justify-center shrink-0 border',
                  selected.has(i) ? 'bg-primary border-primary' : 'border-border'
                )}>
                  {selected.has(i) && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">{entry.title}</p>
                  {entry.duration > 0 && (
                    <p className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                      <Clock className="w-2.5 h-2.5" />
                      {formatDuration(entry.duration)}
                    </p>
                  )}
                </div>
              </button>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/30">
            <button
              onClick={onClose}
              disabled={isProcessing}
              className="px-4 py-2 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97] disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={handleQueue}
              disabled={selected.size === 0 || isProcessing}
              className="px-4 py-2 rounded-lg bg-primary text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97] disabled:opacity-40"
            >
              {isProcessing ? 'Queuing...' : `Queue ${selected.size} Video${selected.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
