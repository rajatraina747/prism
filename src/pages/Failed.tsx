import React from 'react';
import { useHistory } from '@/stores/AppProvider';
import { EmptyState } from '@/components/common';
import { formatBytes } from '@/services';
import { XCircle, RotateCcw, Trash2, AlertTriangle } from 'lucide-react';

export default function Failed() {
  const { items, removeFromHistory } = useHistory();
  const failed = items.filter(i => i.status === 'failed');

  return (
    <div className="page-container">
      <div className="flex items-center justify-between page-header">
        <div>
          <h2 className="page-title">Failed Downloads</h2>
          <p className="page-subtitle">{failed.length} failed item{failed.length !== 1 ? 's' : ''}</p>
        </div>
        {failed.length > 0 && (
          <button
            onClick={() => failed.forEach(i => removeFromHistory(i.id))}
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
                <button
                  onClick={() => removeFromHistory(item.id)}
                  title="Remove"
                  className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-destructive transition-colors active:scale-[0.95] shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
