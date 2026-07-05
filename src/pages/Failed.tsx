import React, { useCallback, useState } from 'react';
import { useHistory, useQueue } from '@/stores/AppProvider';
import { EmptyState, ConfirmDialog } from '@/components/common';
import { generateId } from '@/services';
import { toast } from 'sonner';
import type { HistoryItem } from '@/types/models';
import { XCircle, RotateCcw, Trash2, AlertTriangle } from 'lucide-react';

export default function Failed() {
  const { items, removeFromHistory } = useHistory();
  const { addToQueue } = useQueue();
  const [confirmClear, setConfirmClear] = useState(false);
  const failed = items.filter(i => i.status === 'failed');

  // Queue the item again with its original settings and drop the failed
  // history entry — a successful retry shouldn't leave a stale failure behind.
  const retry = useCallback((item: HistoryItem) => {
    addToQueue({
      id: generateId(),
      metadata: item.metadata,
      settings: item.settings,
      status: 'queued',
      progress: 0,
      speed: 0,
      eta: 0,
      downloadedBytes: 0,
      totalBytes: item.settings.format?.fileSize || 500_000_000,
      retryAttempt: 0,
    });
    removeFromHistory(item.id);
    toast.success(`Retrying: ${item.metadata.title}`);
  }, [addToQueue, removeFromHistory]);

  return (
    <div className="page-container">
      <div className="flex items-center justify-between page-header">
        <div>
          <h2 className="page-title">Failed Downloads</h2>
          <p className="page-subtitle">{failed.length} failed item{failed.length !== 1 ? 's' : ''}</p>
        </div>
        {failed.length > 0 && (
          <button
            onClick={() => setConfirmClear(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
          >
            <Trash2 className="w-3 h-3" /> Clear All
          </button>
        )}
      </div>

      {failed.length === 0 ? (
        <EmptyState
          icon={XCircle}
          title="No failed downloads"
          description="Downloads that encounter errors will appear here with diagnostics and retry options."
        />
      ) : (
        <div className="space-y-1.5">
          {failed.map((item, i) => (
            <div
              key={item.id}
              className="glass-strong rounded-xl p-3.5 animate-fade-in"
              style={{ animationDelay: `${i * 50}ms` }}
            >
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-destructive/10 flex items-center justify-center shrink-0 mt-0.5">
                  <AlertTriangle className="w-4 h-4 text-destructive" />
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="text-xs font-medium text-foreground truncate">{item.metadata.title}</h4>
                  {item.error && (
                    <div className="mt-1.5 space-y-1">
                      <p className="text-[11px] text-destructive">{item.error.message}</p>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span className="capitalize">{item.error.category} error</span>
                        <span>·</span>
                        <span>{item.error.code}</span>
                      </div>
                      {item.error.suggestion && (
                        <p className="text-[10px] text-muted-foreground/70 italic">{item.error.suggestion}</p>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => retry(item)}
                    title="Retry download"
                    aria-label="Retry download"
                    className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => removeFromHistory(item.id)}
                    title="Remove"
                    aria-label="Remove"
                    className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-destructive transition-colors active:scale-[0.95]"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear all failed downloads?"
        description={`This removes ${failed.length} failed item${failed.length !== 1 ? 's' : ''} from the list. The originals can't be restored.`}
        confirmLabel="Clear All"
        destructive
        onConfirm={() => failed.forEach(i => removeFromHistory(i.id))}
      />
    </div>
  );
}
