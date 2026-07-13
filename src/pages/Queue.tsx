import React, { useCallback, useState } from 'react';
import { useQueue, useHistory } from '@/stores/AppProvider';
import { QueueTable } from '@/components/queue/QueueTable';
import { EmptyState } from '@/components/common';
import { formatSpeed } from '@/services';
import { toast } from 'sonner';
import { ArrowDownToLine, Pause, Play, Search } from 'lucide-react';

export default function Queue() {
  const { items, addToQueue, pauseDownload, resumeDownload, cancelDownload, retryDownload, removeFromQueue, startAll, pauseAll, reorderQueue, updateTorrentFiles } = useQueue();
  const { removeFromHistory } = useHistory();

  // Cancel is a single click on a possibly hours-old download — no confirm
  // dialog, but give a few seconds to undo (undo restarts from the top).
  const cancelWithUndo = useCallback((id: string) => {
    const item = items.find(i => i.id === id);
    if (item?.status === 'seeding') {
      // Stopping a seed completes the (already fully downloaded) item — nothing
      // to undo, and the completion toast covers the feedback.
      cancelDownload(id);
      return;
    }
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

  const [search, setSearch] = useState('');
  const activeItems = items.filter(i => !['completed', 'canceled'].includes(i.status));

  // The table only shows active items, but reorderQueue splices the full queue
  // (which can still hold completed/canceled items awaiting archival) — map
  // visible indexes to full-queue indexes via item ids.
  const reorderActive = useCallback((fromIndex: number, toIndex: number) => {
    const fromId = activeItems[fromIndex]?.id;
    const toId = activeItems[toIndex]?.id;
    const from = items.findIndex(i => i.id === fromId);
    const to = items.findIndex(i => i.id === toId);
    if (from !== -1 && to !== -1) reorderQueue(from, to);
  }, [items, activeItems, reorderQueue]);
  // Reordering while a search filter is active would map filtered indexes onto
  // the full queue — only offer search-as-filter, and reorder on the full list.
  const visibleItems = search
    ? activeItems.filter(i => i.metadata.title.toLowerCase().includes(search.toLowerCase()))
    : activeItems;
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

      {activeItems.length > 3 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-input border border-border/40 mb-4 max-w-sm">
          <Search className="w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter queue..."
            aria-label="Filter queue"
            className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/50 outline-none"
          />
        </div>
      )}

      {activeItems.length === 0 ? (
        <EmptyState
          icon={ArrowDownToLine}
          title="Queue is empty"
          description="Downloads you add will appear here. Paste a URL on the Dashboard to get started."
        />
      ) : visibleItems.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No matches"
          description={`Nothing in the queue matches “${search}”.`}
        />
      ) : (
        <QueueTable
          items={visibleItems}
          onPause={pauseDownload}
          onResume={resumeDownload}
          onCancel={cancelWithUndo}
          onRetry={retryDownload}
          onRemove={removeFromQueue}
          onReorder={search ? undefined : reorderActive}
          onUpdateFiles={updateTorrentFiles}
        />
      )}
    </div>
  );
}
