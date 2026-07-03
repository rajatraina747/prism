import React, { useState, useCallback } from 'react';
import { useHistory, useQueue } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { EmptyState } from '@/components/common';
import { formatBytes, generateId } from '@/services';
import { Clock, Search, Trash2, CheckCircle2, XCircle, Ban, RotateCcw, FolderOpen, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { HistoryItem } from '@/types/models';

type FilterTab = 'all' | 'completed' | 'failed' | 'canceled';

export default function History() {
  const { items, removeFromHistory, clearHistory } = useHistory();
  const { addToQueue } = useQueue();
  const service = useService();
  const [tab, setTab] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');

  // Queue the same video again with the settings it was originally
  // downloaded with; the history entry stays put.
  const redownload = useCallback((item: HistoryItem) => {
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
    toast.success(`Queued again: ${item.metadata.title}`);
  }, [addToQueue]);

  const filtered = items
    .filter(i => tab === 'all' || i.status === tab)
    .filter(i => !search || i.metadata.title.toLowerCase().includes(search.toLowerCase()));

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: items.length },
    { key: 'completed', label: 'Completed', count: items.filter(i => i.status === 'completed').length },
    { key: 'failed', label: 'Failed', count: items.filter(i => i.status === 'failed').length },
    { key: 'canceled', label: 'Canceled', count: items.filter(i => i.status === 'canceled').length },
  ];

  const statusIcon = (status: string) => {
    if (status === 'completed') return <CheckCircle2 className="w-3 h-3 text-success" />;
    if (status === 'failed') return <XCircle className="w-3 h-3 text-destructive" />;
    return <Ban className="w-3 h-3 text-muted-foreground" />;
  };

  return (
    <div className="page-container">
      <div className="flex items-center justify-between page-header">
        <div>
          <h2 className="page-title">History</h2>
          <p className="page-subtitle">All past downloads</p>
        </div>
        {items.length > 0 && (
          <button
            onClick={clearHistory}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
          >
            <Trash2 className="w-3 h-3" /> Clear History
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors active:scale-[0.97]',
              tab === t.key ? 'bg-primary/12 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-secondary-foreground'
            )}
          >
            {t.label}
            <span className="ml-1.5 tabular-nums opacity-60">{t.count}</span>
          </button>
        ))}
      </div>

      {/* Search */}
      {items.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-input border border-border/40 mb-4 max-w-sm">
          <Search className="w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search history..."
            className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/50 outline-none"
          />
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          icon={Clock}
          title="No history yet"
          description="Your download history will build up here as you complete downloads."
        />
      ) : (
        <div className="space-y-1.5">
          {filtered.map((item, i) => (
            <div
              key={item.id}
              className="glass-strong rounded-xl p-3 flex items-center gap-3 animate-fade-in"
              style={{ animationDelay: `${i * 40}ms` }}
            >
              {statusIcon(item.status)}
              <div className="flex-1 min-w-0">
                <h4 className="text-xs font-medium text-foreground truncate">{item.metadata.title}</h4>
                <div className="flex items-center gap-3 mt-0.5 text-[10px] text-muted-foreground tabular-nums">
                  {item.settings.format && <span>{item.settings.format.resolution}</span>}
                  <span>{formatBytes(item.fileSize)}</span>
                  <span>{new Date(item.completedAt).toLocaleDateString()}</span>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {item.status === 'completed' && item.filePath && (
                  <>
                    <button
                      onClick={() => service.openFile(item.filePath!).catch(() => toast.error('File not found — it may have been moved or deleted'))}
                      title="Play"
                      className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                    >
                      <Play className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => service.showInFolder(item.filePath!).catch(() => toast.error('File not found — it may have been moved or deleted'))}
                      title="Show in folder"
                      className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
                <button
                  onClick={() => redownload(item)}
                  title="Download again"
                  className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => removeFromHistory(item.id)}
                  title="Remove from history"
                  className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-destructive transition-colors active:scale-[0.95]"
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
