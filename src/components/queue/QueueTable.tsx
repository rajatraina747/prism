import React, { useState, useRef, useCallback } from 'react';
import type { DownloadItem } from '@/types/models';
import { StatusBadge, ProgressBar, Thumb } from '@/components/common';
import { formatBytes, formatSpeed, formatEta } from '@/services';
import { cn } from '@/lib/utils';
import {
  Pause, Play, X, RotateCcw, Trash2, GripVertical, ArrowDownToLine,
} from 'lucide-react';

interface QueueTableProps {
  items: DownloadItem[];
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
}

export function QueueTable({ items, onPause, onResume, onCancel, onRetry, onRemove, onReorder }: QueueTableProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const dragNodeRef = useRef<HTMLDivElement | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    // Make the drag image slightly transparent
    if (e.currentTarget instanceof HTMLElement) {
      dragNodeRef.current = e.currentTarget as HTMLDivElement;
      e.currentTarget.style.opacity = '0.5';
    }
  }, []);

  const handleDragEnd = useCallback(() => {
    if (dragNodeRef.current) {
      dragNodeRef.current.style.opacity = '1';
    }
    setDragIndex(null);
    setOverIndex(null);
    dragNodeRef.current = null;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOverIndex(index);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    const fromIndex = dragIndex;
    if (fromIndex !== null && fromIndex !== toIndex && onReorder) {
      onReorder(fromIndex, toIndex);
    }
    setDragIndex(null);
    setOverIndex(null);
  }, [dragIndex, onReorder]);

  return (
    <div className="space-y-1.5">
      {items.map((item, index) => {
        const isDropTarget = overIndex === index && dragIndex !== null && dragIndex !== index;
        const isBeingDragged = dragIndex === index;

        return (
          <div
            key={item.id}
            draggable={!!onReorder}
            onDragStart={(e) => handleDragStart(e, index)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, index)}
            onDrop={(e) => handleDrop(e, index)}
            className={cn(
              'transition-all duration-200',
              isDropTarget && dragIndex !== null && dragIndex < index && 'translate-y-1 border-b-2 border-b-primary/40',
              isDropTarget && dragIndex !== null && dragIndex > index && '-translate-y-1 border-t-2 border-t-primary/40',
              isBeingDragged && 'opacity-50 scale-[0.98]',
            )}
          >
            <QueueRow
              item={item}
              index={index}
              count={items.length}
              onPause={onPause}
              onResume={onResume}
              onCancel={onCancel}
              onRetry={onRetry}
              onRemove={onRemove}
              onReorder={onReorder}
            />
          </div>
        );
      })}
    </div>
  );
}

const QueueRow = React.memo(function QueueRow({
  item, index, count, onPause, onResume, onCancel, onRetry, onRemove, onReorder,
}: {
  item: DownloadItem; index: number; count: number;
  onPause: (id: string) => void; onResume: (id: string) => void;
  onCancel: (id: string) => void; onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
}) {
  const isActive = item.status === 'downloading';
  const isPaused = item.status === 'paused';
  const isSeeding = item.status === 'seeding';
  const isFailed = item.status === 'failed';
  const isTerminal = item.status === 'completed' || item.status === 'canceled';
  const isTorrent = item.kind === 'torrent';
  const [showFiles, setShowFiles] = useState(false);
  const files = item.files ?? [];

  return (
    <div
      className="glass-strong rounded-xl p-3.5 animate-fade-in"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="flex items-start gap-3">
        {/* Drag Handle — also a keyboard control: focus it and use arrow keys */}
        {onReorder && (
          <div
            role="button"
            tabIndex={0}
            className="flex items-center justify-center w-5 h-12 shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground focus:text-muted-foreground transition-colors"
            title="Drag to reorder (or focus and use arrow keys)"
            aria-label={`Reorder ${item.metadata.title} — position ${index + 1} of ${count}. Use arrow keys to move.`}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp' && index > 0) {
                e.preventDefault();
                onReorder(index, index - 1);
              } else if (e.key === 'ArrowDown' && index < count - 1) {
                e.preventDefault();
                onReorder(index, index + 1);
              }
            }}
          >
            <GripVertical className="w-4 h-4" strokeWidth={1.5} />
          </div>
        )}

        {/* Thumbnail — Thumb falls back to a neutral tile (torrents have none) */}
        <Thumb
          src={item.metadata.thumbnail}
          className="w-20 h-12"
          fallbackIcon={<ArrowDownToLine className="w-4 h-4 text-muted-foreground/50" />}
        />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="text-xs font-medium text-foreground truncate">{item.metadata.title}</h4>
            <StatusBadge status={item.status} />
          </div>

          {/* Progress bar for active/paused/seeding */}
          {(isActive || isPaused || isSeeding) && (
            <ProgressBar value={item.progress} className="mb-1.5" />
          )}

          {/* Stats row */}
          <div className="flex items-center gap-4 text-[11px] text-muted-foreground tabular-nums">
            {item.settings.audioOnly ? (
              <span className="text-primary/80">Audio only</span>
            ) : item.settings.format ? (
              <span>{item.settings.format.resolution} · {item.settings.format.container.toUpperCase()}</span>
            ) : null}
            {item.settings.downloadSubtitles && (
              <span className="text-muted-foreground/70">+ Subs</span>
            )}
            {isActive && (
              <>
                <span>{formatBytes(item.downloadedBytes)} / {formatBytes(item.totalBytes)}</span>
                <span>{formatSpeed(item.speed)}</span>
                <span>ETA {formatEta(item.eta)}</span>
                <span>{item.progress.toFixed(1)}%</span>
                {isTorrent && <span>{item.peers ?? 0} peers</span>}
              </>
            )}
            {isSeeding && (
              <>
                <span className="text-success">Seeding</span>
                <span>↑ {formatSpeed(item.uploadSpeed ?? 0)}</span>
                <span>{item.peers ?? 0} peers</span>
                <span>ratio {(item.ratio ?? 0).toFixed(2)}</span>
              </>
            )}
            {isPaused && (
              <span>{formatBytes(item.downloadedBytes)} / {formatBytes(item.totalBytes)} · {item.progress.toFixed(1)}%</span>
            )}
            {isFailed && item.error && (
              <span className="text-destructive">{item.error.message}</span>
            )}
          </div>

          {/* Multi-file torrent breakdown */}
          {isTorrent && files.length > 1 && (isActive || isSeeding || isPaused) && (
            <div className="mt-1.5">
              <button
                onClick={() => setShowFiles(v => !v)}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {showFiles ? '▾' : '▸'} {files.length} files
              </button>
              {showFiles && (
                <div className="mt-1 space-y-0.5">
                  {files.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
                      <span className="truncate flex-1" title={f.name}>{f.name.split('/').pop()}</span>
                      <span>{formatBytes(f.size)}</span>
                      <span className="w-9 text-right">{f.progress.toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {isActive && (
            <ActionButton icon={Pause} onClick={() => onPause(item.id)} tooltip="Pause" />
          )}
          {isPaused && (
            <ActionButton icon={Play} onClick={() => onResume(item.id)} tooltip="Resume" />
          )}
          {isFailed && (
            <ActionButton icon={RotateCcw} onClick={() => onRetry(item.id)} tooltip="Retry" />
          )}
          {(isActive || isPaused || isSeeding || item.status === 'queued') && (
            <ActionButton icon={X} onClick={() => onCancel(item.id)} tooltip={isSeeding ? 'Stop seeding' : 'Cancel'} />
          )}
          {isTerminal && (
            <ActionButton icon={Trash2} onClick={() => onRemove(item.id)} tooltip="Remove" />
          )}
        </div>
      </div>
    </div>
  );
});

function ActionButton({ icon: Icon, onClick, tooltip }: { icon: React.ElementType; onClick: () => void; tooltip: string }) {
  return (
    <button
      onClick={onClick}
      title={tooltip}
      aria-label={tooltip}
      className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
    >
      <Icon className="w-3.5 h-3.5" strokeWidth={1.8} />
    </button>
  );
}
