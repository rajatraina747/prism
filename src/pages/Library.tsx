import React, { useState, useCallback } from 'react';
import { useHistory, useQueue } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { EmptyState, Thumb, ConfirmDialog } from '@/components/common';
import { formatBytes, generateId, isTorrentUrl } from '@/services';
import {
  Clock, Search, Trash2, CheckCircle2, XCircle, Ban, RotateCcw,
  FolderOpen, Play, Copy, AlertTriangle, MonitorPlay, ChevronRight,
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

// The embedded player needs the libmpv wrapper staged next to the executable,
// which dev builds do and bundled releases don't yet (ROADMAP → In-app player
// → Distribution) — ask the backend rather than assuming.
function usePlayerAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  React.useEffect(() => {
    if (!('__TAURI__' in window)) return;
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<boolean>('player_available'))
      .then(setAvailable)
      .catch(() => {});
  }, []);
  return available;
}

function playInPrism(path: string, title: string) {
  // Dynamic import keeps the Tauri window APIs out of the web-demo bundle path.
  import('@/lib/player-window')
    .then(({ openInPlayer }) => openInPlayer({ path, title }))
    .catch((e) => toast.error(`Couldn't open the player: ${e instanceof Error ? e.message : e}`));
}

/** Absolute(ish) path of one file inside a torrent download — file names in
 * history are relative to the item's destination folder. */
function torrentFilePath(item: HistoryItem, name: string): string {
  const dest = (item.settings.destination || '~/Downloads/Prism').replace(/\/+$/, '');
  return `${dest}/${name}`;
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
  // Torrent row whose per-file list is expanded (one at a time keeps it tidy).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const playerAvailable = usePlayerAvailable();

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
                    {(() => {
                      // Show what was actually delivered; call out a shortfall
                      // vs the requested quality instead of hiding it.
                      const requested = item.settings.format?.resolution;
                      const actual = item.actualHeight ? `${item.actualHeight}p` : undefined;
                      if (actual && requested && actual !== requested) {
                        return <span className="text-amber-500" title={`Requested ${requested}, the site delivered ${actual}`}>{actual} (asked {requested})</span>;
                      }
                      const label = actual ?? requested;
                      return label ? <span>{label}</span> : null;
                    })()}
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
                  {/* Torrent: expandable per-file list with per-file actions */}
                  {item.status === 'completed' && item.files && item.files.length > 0 && (
                    <div className="mt-1.5">
                      <button
                        onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                        aria-expanded={expandedId === item.id}
                      >
                        <ChevronRight className={cn('w-3 h-3 transition-transform', expandedId === item.id && 'rotate-90')} />
                        {item.files.length} {item.files.length === 1 ? 'file' : 'files'}
                      </button>
                      {expandedId === item.id && (
                        <ul className="mt-1 space-y-0.5">
                          {item.files.map((f) => (
                            <li key={f.name} className="flex items-center gap-2 text-[11px] text-muted-foreground group">
                              <span className="truncate flex-1" title={f.name}>{f.name}</span>
                              <span className="tabular-nums shrink-0">{formatBytes(f.size)}</span>
                              {playerAvailable && (
                                <button
                                  onClick={() => playInPrism(torrentFilePath(item, f.name), f.name.split('/').pop() ?? f.name)}
                                  title="Play in Prism"
                                  aria-label={`Play ${f.name} in Prism`}
                                  className="p-1 rounded hover:bg-secondary hover:text-foreground transition-colors"
                                >
                                  <MonitorPlay className="w-3 h-3" />
                                </button>
                              )}
                              <button
                                onClick={() => service.openFile(torrentFilePath(item, f.name)).catch(() => toast.error('File not found — it may have been moved or deleted'))}
                                title="Open in default player"
                                aria-label={`Open ${f.name}`}
                                className="p-1 rounded hover:bg-secondary hover:text-foreground transition-colors"
                              >
                                <Play className="w-3 h-3" />
                              </button>
                              <button
                                onClick={() => service.showInFolder(torrentFilePath(item, f.name)).catch(() => toast.error('File not found — it may have been moved or deleted'))}
                                title="Show in folder"
                                aria-label={`Show ${f.name} in folder`}
                                className="p-1 rounded hover:bg-secondary hover:text-foreground transition-colors"
                              >
                                <FolderOpen className="w-3 h-3" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {item.status === 'completed' && (() => {
                    const isTorrent = isTorrentUrl(item.metadata.source.url);
                    // Older torrent completions (flat multi-file torrents)
                    // were recorded without a path — falling back to the
                    // destination folder keeps the files reachable.
                    const revealTarget = item.filePath
                      ?? (isTorrent ? item.settings.destination : undefined);
                    return (
                      <>
                        {/* In-app player: mpv handles anything, including a
                            multi-file torrent's folder (loaded as a playlist). */}
                        {playerAvailable && item.filePath && (
                          <button
                            onClick={() => playInPrism(item.filePath!, item.metadata.title)}
                            title="Play in Prism"
                            aria-label="Play in Prism"
                            className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                          >
                            <MonitorPlay className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {/* Multi-file torrents resolve to a folder the OS can't
                            "play" — Show in Folder covers those. */}
                        {!isTorrent && item.filePath && (
                          <button
                            onClick={() => service.openFile(item.filePath!).catch(() => toast.error('File not found — it may have been moved or deleted'))}
                            title="Open in default player"
                            aria-label="Open in default player"
                            className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                          >
                            <Play className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {revealTarget && (
                          <button
                            onClick={() => service.showInFolder(revealTarget).catch(() => toast.error('File not found — it may have been moved or deleted'))}
                            title="Show in folder"
                            aria-label="Show in folder"
                            className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                          >
                            <FolderOpen className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          onClick={() => service.copyToClipboard(item.metadata.source.url).then(() => toast.success('URL copied')).catch(() => toast.error('Copy failed'))}
                          title="Copy source URL"
                          aria-label="Copy source URL"
                          className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </>
                    );
                  })()}
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
