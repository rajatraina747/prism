import React, { useCallback } from 'react';
import { useQueue, useHistory } from '@/stores/AppProvider';
import { QueueTable } from '@/components/queue/QueueTable';
import { EmptyState } from '@/components/common';
import { formatSpeed } from '@/services';
import { toast } from 'sonner';
import { ArrowDownToLine, Pause, Play } from 'lucide-react';

export default function Queue() {
  const { items, addToQueue, pauseDownload, resumeDownload, cancelDownload, retryDownload, removeFromQueue, startAll, pauseAll, reorderQueue } = useQueue();
  const { removeFromHistory } = useHistory();

  // Cancel is a single click on a possibly hours-old download — no confirm
  // dialog, but give a few seconds to undo (undo restarts from the top).
  const cancelWithUndo = useCallback((id: string) => {
    const item = items.find(i => i.id === id);
    cancelDownload(id);
    toast(`Canceled: ${item?.metadata.title ?? 'download'}`, {
      action: {
        label: 'Undo',
        onClick: () => {
          if (!item) return;
          // The canceled item may still be in the queue, or already archived
          // to history (that happens ~2s after cancel) — cover both: drop any
          // trace of the canceled copy, then re-queue a fresh one.
          removeFromQueue(id);
          removeFromHistory(id);
          addToQueue({
            ...item,
            status: 'queued',
            progress: 0,
            speed: 0,
            eta: 0,
            downloadedBytes: 0,
            error: undefined,
          });
        },
      },
      duration: 6000,
    });
  }, [items, cancelDownload, removeFromQueue, removeFromHistory, addToQueue]);

  const activeItems = items.filter(i => !['completed', 'canceled'].includes(i.status));
  const downloading = items.filter(i => i.status === 'downloading');
  const hasActive = downloading.length > 0;
  const hasPaused = items.some(i => i.status === 'paused' || i.status === 'queued');
  const totalSpeed = downloading.reduce((sum, i) => sum + (i.speed || 0), 0);

  const subtitle = [
    `${activeItems.length} item${activeItems.length !== 1 ? 's' : ''} in queue`,
    hasActive && `${downloading.length} downloading`,
    totalSpeed > 0 && formatSpeed(totalSpeed),
  ].filter(Boolean).join(' · ');

  return (
    <div className="page-container">
      <div className="flex items-center justify-between page-header">
        <div>
          <h2 className="page-title">Download Queue</h2>
          <p className="page-subtitle tabular-nums">{subtitle}</p>
        </div>
        <div className="flex gap-1.5">
          {hasActive && (
            <button onClick={pauseAll} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]">
              <Pause className="w-3 h-3" /> Pause All
            </button>
          )}
          {hasPaused && (
            <button onClick={startAll} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/15 text-xs font-medium text-primary hover:bg-primary/20 transition-colors active:scale-[0.97]">
              <Play className="w-3 h-3" /> Resume All
            </button>
          )}
        </div>
      </div>

      {activeItems.length === 0 ? (
        <EmptyState
          icon={ArrowDownToLine}
          title="Queue is empty"
          description="Downloads you add will appear here. Paste a URL on the Dashboard to get started."
        />
      ) : (
        <QueueTable
          items={activeItems}
          onPause={pauseDownload}
          onResume={resumeDownload}
          onCancel={cancelWithUndo}
          onRetry={retryDownload}
          onRemove={removeFromQueue}
          onReorder={reorderQueue}
        />
      )}
    </div>
  );
}
