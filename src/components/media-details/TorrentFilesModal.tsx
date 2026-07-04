import React, { useState, useRef, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { TorrentFileEntry } from '@/types/models';
import { formatBytes } from '@/services';
import { cn } from '@/lib/utils';
import { FolderTree, Check, Loader2 } from 'lucide-react';

interface TorrentFilesModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  files: TorrentFileEntry[] | null; // null = still loading
  onConfirm: (selectedIndices: number[]) => void;
}

/** Pick which files inside a torrent to download. All are selected by default;
 * deselecting some passes only the chosen indices to the engine. */
export function TorrentFilesModal({ open, onClose, title, files, onConfirm }: TorrentFilesModalProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const seededFor = useRef<string | null>(null);

  // Select everything when a new file list arrives.
  React.useEffect(() => {
    if (files && seededFor.current !== title) {
      seededFor.current = title;
      setSelected(new Set(files.map(f => f.index)));
    }
    if (!open) seededFor.current = null;
  }, [files, title, open]);

  const totalSelectedBytes = useMemo(
    () => (files ?? []).filter(f => selected.has(f.index)).reduce((sum, f) => sum + f.size, 0),
    [files, selected],
  );

  const toggle = (index: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const allSelected = !!files && selected.size === files.length;
  const toggleAll = () => {
    if (!files) return;
    setSelected(allSelected ? new Set() : new Set(files.map(f => f.index)));
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="glass-strong max-w-lg border-border/40 bg-card/95 p-0 gap-0">
        <DialogHeader className="p-5 pb-0 min-w-0">
          <div className="flex items-center gap-2 min-w-0 pr-10">
            <FolderTree className="w-4 h-4 text-primary shrink-0" />
            <DialogTitle className="min-w-0 flex-1 truncate text-base font-semibold text-foreground leading-snug" title={title}>
              {title}
            </DialogTitle>
          </div>
        </DialogHeader>

        {files === null ? (
          <div className="p-10 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-xs">Fetching file list from peers…</span>
          </div>
        ) : (
          <div className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="rounded border-border"
                />
                <span className="text-xs text-muted-foreground">
                  Select all ({selected.size}/{files.length})
                </span>
              </label>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {formatBytes(totalSelectedBytes)} selected
              </span>
            </div>

            <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
              {files.map(file => (
                <button
                  key={file.index}
                  onClick={() => toggle(file.index)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors',
                    selected.has(file.index)
                      ? 'bg-primary/8 border border-primary/20'
                      : 'bg-secondary/30 border border-transparent hover:bg-secondary/50',
                  )}
                >
                  <div className={cn(
                    'w-4 h-4 rounded flex items-center justify-center shrink-0 border',
                    selected.has(file.index) ? 'bg-primary border-primary' : 'border-border',
                  )}>
                    {selected.has(file.index) && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                  </div>
                  <span className="flex-1 min-w-0 text-xs font-medium text-foreground truncate" title={file.name}>
                    {file.name.split('/').pop()}
                  </span>
                  <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                    {formatBytes(file.size)}
                  </span>
                </button>
              ))}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/30">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
              >
                Cancel
              </button>
              <button
                onClick={() => onConfirm([...selected])}
                disabled={selected.size === 0}
                className="px-4 py-2 rounded-lg bg-primary text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97] disabled:opacity-40"
              >
                Download {selected.size} File{selected.size !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
