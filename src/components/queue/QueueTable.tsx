import React from 'react';
import type { DownloadItem } from '@/types/models';
import { StatusBadge, ProgressBar } from '@/components/common';
import { formatBytes, formatSpeed, formatEta } from '@/services';
import { cn } from '@/lib/utils';
import {
  Pause, Play, X, RotateCcw, Trash2, MoreHorizontal,
} from 'lucide-react';

interface QueueTableProps {
  items: DownloadItem[];
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}

export function QueueTable({ items, onPause, onResume, onCancel, onRetry, onRemove }: QueueTableProps) {
  return (
    <div className="space-y-1.5">
      {items.map((item, index) => (
        <QueueRow
          key={item.id}
          item={item}
          index={index}
          onPause={onPause}
          onResume={onResume}
          onCancel={onCancel}
          onRetry={onRetry}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}

function QueueRow({
  item, index, onPause, onResume, onCancel, onRetry, onRemove,
}: {
  item: DownloadItem; index: number;
  onPause: (id: string) => void; onResume: (id: string) => void;
  onCancel: (id: string) => void; onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const isActive = item.status === 'downloading';
  const isPaused = item.status === 'paused';
  const isFailed = item.status === 'failed';
  const isTerminal = item.status === 'completed' || item.status === 'canceled';

  return (
    <div
      className="glass-strong rounded-xl p-3.5 animate-fade-in"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="flex items-start gap-3">
        {/* Thumbnail */}
        <img
          src={item.metadata.thumbnail}
          alt=""
          className="w-20 h-12 rounded-md object-cover bg-secondary shrink-0"
        />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="text-xs font-medium text-foreground truncate">{item.metadata.title}</h4>
            <StatusBadge status={item.status} />
          </div>

          {/* Progress bar for active/paused */}
          {(isActive || isPaused) && (
            <ProgressBar value={item.progress} className="mb-1.5" />
          )}

          {/* Stats row */}
          <div className="flex items-center gap-4 text-[10px] text-muted-foreground tabular-nums">
            {item.settings.format && (
              <span>{item.settings.format.resolution} · {item.settings.format.container.toUpperCase()}</span>
            )}
            {isActive && (
              <>
                <span>{formatBytes(item.downloadedBytes)} / {formatBytes(item.totalBytes)}</span>
                <span>{formatSpeed(item.speed)}</span>
                <span>ETA {formatEta(item.eta)}</span>
                <span>{item.progress.toFixed(1)}%</span>
              </>
            )}
            {isPaused && (
              <span>{formatBytes(item.downloadedBytes)} / {formatBytes(item.totalBytes)} · {item.progress.toFixed(1)}%</span>
            )}
            {isFailed && item.error && (
              <span className="text-destructive">{item.error.message}</span>
            )}
          </div>
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
          {(isActive || isPaused || item.status === 'queued') && (
            <ActionButton icon={X} onClick={() => onCancel(item.id)} tooltip="Cancel" />
          )}
          {isTerminal && (
            <ActionButton icon={Trash2} onClick={() => onRemove(item.id)} tooltip="Remove" />
          )}
        </div>
      </div>
    </div>
  );
}

function ActionButton({ icon: Icon, onClick, tooltip }: { icon: React.ElementType; onClick: () => void; tooltip: string }) {
  return (
    <button
      onClick={onClick}
      title={tooltip}
      className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
    >
      <Icon className="w-3.5 h-3.5" strokeWidth={1.8} />
    </button>
  );
}
