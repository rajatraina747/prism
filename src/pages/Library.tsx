import React, { useState, useCallback } from 'react';
import { useHistory, useQueue } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { EmptyState, Thumb, ConfirmDialog } from '@/components/common';
import { formatBytes, generateId, isTorrentUrl } from '@/services';
import {
  Clock, Search, Trash2, CheckCircle2, XCircle, Ban, RotateCcw,
  FolderOpen, Play, Copy, AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { HistoryItem } from '@/types/models';

type FilterTab = 'all' | 'completed' | 'failed' | 'canceled';

const TAB_LABELS: Record<FilterTab, string> = {
  all: 'All',
  completed: 'Completed',
  failed: 'Failed',
  canceled: 'Canceled',
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** One page for everything that has finished, one way or another: completed,
 * failed, and canceled downloads, in tabs. Replaces the old Downloads / Failed /
 * History trio, which showed the same records three ways. */
export default function Library() {
  const { items, removeFromHistory, clearHistory } = useHistory();
  const { addToQueue } = useQueue();
  const service = useService();
  const [tab, setTab] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  // Queue the same video again with its original settings. For failed items the
  // stale failure entry is dropped (a successful retry shouldn't leave it
  // behind); completed/canceled entries stay put.
  const requeue = useCallback((item: HistoryItem) => {
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
      kind: isTorrentUrl(item.metadata.source.url) ? 'torrent' : undefined,
    });
    if (item.status === 'failed') removeFromHistory(item.id);
    toast.success(`${item.status === 'failed' ? 'Retrying' : 'Queued again'}: ${item.metadata.title}`);
  }, [addToQueue, removeFromHistory]);

  const inTab = items.filter(i => tab === 'all' || i.status === tab);
  const filtered = inTab.filter(i => !search || i.metadata.title.toLowerCase().includes(search.toLowerCase()));

  const tabs = (['all', 'completed', 'failed', 'canceled'] as const).map(key => ({
    key,
    label: TAB_LABELS[key],
    count: key === 'all' ? items.length : items.filter(i => i.status === key).length,
  }));

  const clearCurrent = useCallback(() => {
    if (tab === 'all') clearHistory();
    else items.filter(i => i.status === tab).forEach(i => removeFromHistory(i.id));
  }, [tab, items, clearHistory, removeFromHistory]);

  const statusIcon = (status: string) => {
    if (status === 'completed') return <CheckCircle2 className="w-3 h-3 text-success" />;
    if (status === 'failed') return <XCircle className="w-3 h-3 text-destructive" />;
    return <Ban className="w-3 h-3 text-muted-foreground" />;
  };

  return (
    <div className="page-container">
      <div className="flex items-center justify-between page-header">
        <div>
          <h2 className="page-title">Library</h2>
          <p className="page-subtitle">Completed, failed, and canceled downloads</p>
        </div>
        {inTab.length > 0 && (
          <button
            onClick={() => setConfirmClear(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
          >
            <Trash2 className="w-3 h-3" /> {tab === 'all' ? 'Clear All' : `Clear ${TAB_LABELS[tab]}`}
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
            placeholder="Search library..."
            aria-label="Search library"
            className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/50 outline-none"
          />
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          icon={tab === 'failed' ? XCircle : Clock}
          title={tab === 'failed' ? 'No failed downloads' : 'Nothing here yet'}
          description={
            tab === 'failed'
              ? 'Downloads that hit errors land here with a reason and a retry button.'
              : 'Finished downloads will appear here. Paste a URL on the Dashboard to get started.'
          }
        />
      ) : (
        <div className="space-y-1.5">
          {filtered.map((item, i) => (
            <div
              key={item.id}
              className="glass-strong rounded-xl p-3 animate-fade-in"
              style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
            >
              <div className="flex items-start gap-3">
                {item.status === 'failed' ? (
                  <div className="w-8 h-8 rounded-lg bg-destructive/10 flex items-center justify-center shrink-0 mt-0.5">
                    <AlertTriangle className="w-4 h-4 text-destructive" />
                  </div>
                ) : (
                  <Thumb
                    src={item.metadata.thumbnail}
                    className="w-[72px] h-10"
                    fallbackIcon={statusIcon(item.status)}
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {statusIcon(item.status)}
                    <h4 className="text-xs font-medium text-foreground truncate">{item.metadata.title}</h4>
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                    {item.settings.format && <span>{item.settings.format.resolution}</span>}
                    {item.settings.audioOnly && <span>Audio</span>}
                    {item.fileSize > 0 && <span>{formatBytes(item.fileSize)}</span>}
                    <span>{formatWhen(item.completedAt)}</span>
                  </div>
                  {item.status === 'failed' && item.error && (
                    <div className="mt-1.5 space-y-1">
                      <p className="text-[11px] text-destructive">{item.error.message}</p>
                      {item.error.suggestion && (
                        <p className="text-[11px] text-muted-foreground/70 italic">{item.error.suggestion}</p>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {item.status === 'completed' && item.filePath && (
                    <>
                      {/* Multi-file torrents resolve to a folder the OS can't
                          "play" — Show in Folder covers those. */}
                      {!isTorrentUrl(item.metadata.source.url) && (
                        <button
                          onClick={() => service.openFile(item.filePath!).catch(() => toast.error('File not found — it may have been moved or deleted'))}
                          title="Play"
                          aria-label="Play"
                          className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                        >
                          <Play className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => service.showInFolder(item.filePath!).catch(() => toast.error('File not found — it may have been moved or deleted'))}
                        title="Show in folder"
                        aria-label="Show in folder"
                        className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => service.copyToClipboard(item.metadata.source.url).then(() => toast.success('URL copied')).catch(() => toast.error('Copy failed'))}
                        title="Copy source URL"
                        aria-label="Copy source URL"
                        className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => requeue(item)}
                    title={item.status === 'failed' ? 'Retry download' : 'Download again'}
                    aria-label={item.status === 'failed' ? 'Retry download' : 'Download again'}
                    className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => removeFromHistory(item.id)}
                    title="Remove from library"
                    aria-label="Remove from library"
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
        title={tab === 'all' ? 'Clear the whole library?' : `Clear all ${TAB_LABELS[tab].toLowerCase()} items?`}
        description={
          tab === 'all'
            ? `This removes all ${items.length} entries — completed, failed, and canceled. Downloaded files stay on disk.`
            : `This removes ${inTab.length} ${TAB_LABELS[tab].toLowerCase()} entr${inTab.length === 1 ? 'y' : 'ies'}. Downloaded files stay on disk.`
        }
        confirmLabel={tab === 'all' ? 'Clear Everything' : `Clear ${TAB_LABELS[tab]}`}
        destructive
        onConfirm={clearCurrent}
      />
    </div>
  );
}
