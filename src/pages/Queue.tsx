import React from 'react';
import { useQueue } from '@/stores/AppProvider';
import { QueueTable } from '@/components/queue/QueueTable';
import { EmptyState } from '@/components/common';
import { ArrowDownToLine, Pause, Play, Trash2 } from 'lucide-react';

export default function Queue() {
  const { items, pauseDownload, resumeDownload, cancelDownload, retryDownload, removeFromQueue, clearCompleted, startAll, pauseAll } = useQueue();

  const activeItems = items.filter(i => !['completed', 'canceled'].includes(i.status));
  const hasActive = items.some(i => i.status === 'downloading');
  const hasPaused = items.some(i => i.status === 'paused' || i.status === 'queued');

  return (
    <div className="page-container">
      <div className="flex items-center justify-between page-header">
        <div>
          <h2 className="page-title">Download Queue</h2>
          <p className="page-subtitle">{activeItems.length} item{activeItems.length !== 1 ? 's' : ''} in queue</p>
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
          onCancel={cancelDownload}
          onRetry={retryDownload}
          onRemove={removeFromQueue}
        />
      )}
    </div>
  );
}
