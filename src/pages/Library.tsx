import React, { useState, useCallback, useMemo } from 'react';
import { useHistory, useQueue } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { EmptyState, Thumb, ConfirmDialog } from '@/components/common';
import { FailureNote } from '@/components/common/FailureNote';
import { VirtualList } from '@/components/common/VirtualList';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatBytes, generateId, isTorrentUrl, isDirectFileUrl } from '@/services';
import { categoriesInUse } from '@/stores/transfers';
import {
  Clock, Search, Trash2, CheckCircle2, XCircle, Ban, RotateCcw,
  FolderOpen, Play, Copy, AlertTriangle, MonitorPlay, ChevronRight, Tag,
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
    import('@tauri-apps/api/core')
      .then(({ isTauri, invoke }) => (isTauri() ? invoke<boolean>('player_available') : false))
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
 * history are relative to the folder the engine wrote into (`outputFolder`;
 * a multi-file torrent gets `<destination>/<name>`), or to the destination
 * itself for items recorded before 1.8.1. */
function torrentFilePath(item: HistoryItem, name: string): string {
  const dest = (item.outputFolder || item.settings.destination || '~/Downloads/Prism').replace(/\/+$/, '');
  return `${dest}/${name}`;
}

const iconButton = 'p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]';

function statusIcon(status: string) {
  if (status === 'completed') return <CheckCircle2 className="w-3 h-3 text-success" aria-label="Completed" />;
  if (status === 'failed') return <XCircle className="w-3 h-3 text-destructive" aria-label="Failed" />;
  return <Ban className="w-3 h-3 text-muted-foreground" aria-label="Canceled" />;
}

/** One page for everything that has finished, one way or another: completed,
 * failed, and canceled downloads, in tabs. Replaces the old Downloads / Failed /
 * History trio, which showed the same records three ways. Long libraries are
 * windowed — only the rows near the viewport are mounted. */
export default function Library() {
  const { items, removeFromHistory, clearHistory } = useHistory();
  const { addToQueue } = useQueue();
  const [tab, setTab] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
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
      // Real size when history has it; torrents and direct files never get
      // the yt-dlp placeholder (it would read as "476.8 MB" until the engine
      // learns the real size).
      totalBytes: item.totalBytes || item.settings.format?.fileSize
        || (isTorrentUrl(item.metadata.source.url) || isDirectFileUrl(item.metadata.source.url) ? 0 : 500_000_000),
      retryAttempt: 0,
      kind: isTorrentUrl(item.metadata.source.url)
        ? 'torrent'
        : isDirectFileUrl(item.metadata.source.url) ? 'direct' : undefined,
    });
    if (item.status === 'failed') removeFromHistory(item.id);
    toast.success(`${item.status === 'failed' ? 'Retrying' : 'Queued again'}: ${item.metadata.title}`);
  }, [addToQueue, removeFromHistory]);

  const inTab = useMemo(() => items.filter(i => tab === 'all' || i.status === tab), [items, tab]);
  const categories = useMemo(() => categoriesInUse(items), [items]);
  // Survives a category being cleared out of the library entirely.
  const activeCategory = category && categories.some(c => c.id === category) ? category : null;
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return inTab.filter(i =>
      (!activeCategory || i.settings.categoryId === activeCategory)
      && (!q || i.metadata.title.toLowerCase().includes(q)));
  }, [inTab, search, activeCategory]);

  const tabs = (['all', 'completed', 'failed', 'canceled'] as const).map(key => ({
    key,
    label: TAB_LABELS[key],
    count: key === 'all' ? items.length : items.filter(i => i.status === key).length,
  }));

  const clearCurrent = useCallback(() => {
    if (tab === 'all') clearHistory();
    else items.filter(i => i.status === tab).forEach(i => removeFromHistory(i.id));
  }, [tab, items, clearHistory, removeFromHistory]);

  const toggleExpanded = useCallback((id: string) => setExpandedId(cur => (cur === id ? null : id)), []);

  return (
    <div className="page-container">
      <div className="flex items-center justify-between page-header">
        <div>
          <h2 className="page-title">Library</h2>
          <p className="page-subtitle">Completed, failed, and canceled downloads</p>
        </div>
        {inTab.length > 0 && (
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
          >
            <Trash2 className="w-3 h-3" /> {tab === 'all' ? 'Clear All' : `Clear ${TAB_LABELS[tab]}`}
          </button>
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as FilterTab)}>
        <TabsList aria-label="Filter library" className="h-auto gap-1 bg-transparent p-0 mb-4">
          {tabs.map(t => (
            <TabsTrigger
              key={t.key}
              value={t.key}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                'text-muted-foreground hover:bg-secondary hover:text-secondary-foreground',
                'data-[state=active]:bg-primary/12 data-[state=active]:text-primary data-[state=active]:shadow-none',
              )}
            >
              {t.label}
              <span className="ml-1.5 tabular-nums opacity-60">{t.count}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        {/* Search + category */}
        {items.length > 0 && (
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-input border border-border/40 w-full max-w-sm">
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
            {categories.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-secondary hover:text-secondary-foreground transition-colors" aria-label="Filter by category">
                    <Tag className="w-3 h-3" />
                    {activeCategory ? categories.find(c => c.id === activeCategory)?.name : 'All categories'}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  <DropdownMenuItem onSelect={() => setCategory(null)} className={cn('text-xs', !activeCategory && 'text-primary')}>All categories</DropdownMenuItem>
                  {categories.map(c => (
                    <DropdownMenuItem key={c.id} onSelect={() => setCategory(c.id)} className={cn('text-xs', activeCategory === c.id && 'text-primary')}>{c.name}</DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}

        <TabsContent value={tab} className="mt-0 focus-visible:ring-0 focus-visible:ring-offset-0">
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
            <VirtualList
              items={filtered}
              getKey={item => item.id}
              estimateSize={64}
              gap={6}
              aria-label={`${TAB_LABELS[tab]} downloads`}
              role="list"
              renderItem={item => (
                <LibraryRow
                  item={item}
                  expanded={expandedId === item.id}
                  playerAvailable={playerAvailable}
                  onToggleExpanded={toggleExpanded}
                  onRequeue={requeue}
                  onRemove={removeFromHistory}
                />
              )}
            />
          )}
        </TabsContent>
      </Tabs>

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

const LibraryRow = React.memo(function LibraryRow({
  item, expanded, playerAvailable, onToggleExpanded, onRequeue, onRemove,
}: {
  item: HistoryItem;
  expanded: boolean;
  playerAvailable: boolean;
  onToggleExpanded: (id: string) => void;
  onRequeue: (item: HistoryItem) => void;
  onRemove: (id: string) => void;
}) {
  const service = useService();
  const isTorrent = isTorrentUrl(item.metadata.source.url);
  const isFailed = item.status === 'failed';

  return (
    <div role="listitem" className="surface-row rounded-xl p-3">
      <div className="flex items-start gap-3">
        {isFailed ? (
          <div className="w-8 h-8 rounded-lg bg-destructive/10 flex items-center justify-center shrink-0 mt-0.5">
            <AlertTriangle className="w-4 h-4 text-destructive" aria-hidden="true" />
          </div>
        ) : (
          <Thumb src={item.metadata.thumbnail} className="w-[72px] h-10" fallbackIcon={statusIcon(item.status)} />
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
                return <span className="text-warning" title={`Requested ${requested}, the site delivered ${actual}`}>{actual} (asked {requested})</span>;
              }
              const label = actual ?? requested;
              return label ? <span>{label}</span> : null;
            })()}
            {item.settings.audioOnly && <span>Audio</span>}
            {item.settings.categoryName && (
              <span className="px-1.5 rounded bg-secondary text-secondary-foreground">{item.settings.categoryName}</span>
            )}
            {item.fileSize > 0 && <span>{formatBytes(item.fileSize)}</span>}
            <span>{formatWhen(item.completedAt)}</span>
          </div>
          {isFailed && item.error && <FailureNote error={item.error} onRetry={() => onRequeue(item)} />}
          {/* Torrent: expandable per-file list with per-file actions */}
          {item.status === 'completed' && item.files && item.files.length > 0 && (
            <div className="mt-1.5">
              <button
                type="button"
                onClick={() => onToggleExpanded(item.id)}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                aria-expanded={expanded}
              >
                <ChevronRight className={cn('w-3 h-3 transition-transform', expanded && 'rotate-90')} />
                {item.files.length} {item.files.length === 1 ? 'file' : 'files'}
              </button>
              {expanded && (
                <ul className="mt-1 space-y-0.5">
                  {item.files.map((f) => (
                    <li key={f.name} className="flex items-center gap-2 text-[11px] text-muted-foreground group">
                      <span className="truncate flex-1" title={f.name}>{f.name}</span>
                      <span className="tabular-nums shrink-0">{formatBytes(f.size)}</span>
                      {playerAvailable && (
                        <button
                          type="button"
                          onClick={() => playInPrism(torrentFilePath(item, f.name), f.name.split('/').pop() ?? f.name)}
                          title="Play in Prism"
                          aria-label={`Play ${f.name} in Prism`}
                          className="p-1 rounded hover:bg-secondary hover:text-foreground transition-colors"
                        >
                          <MonitorPlay className="w-3 h-3" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => service.openFile(torrentFilePath(item, f.name)).catch((e) => toast.error(e instanceof Error ? e.message : String(e)))}
                        title="Open in default player"
                        aria-label={`Open ${f.name}`}
                        className="p-1 rounded hover:bg-secondary hover:text-foreground transition-colors"
                      >
                        <Play className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
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
            // Older torrent completions (flat multi-file torrents) were
            // recorded without a path — falling back to the destination
            // folder keeps the files reachable.
            const revealTarget = item.filePath
              ?? (isTorrent ? (item.outputFolder ?? item.settings.destination) : undefined);
            return (
              <>
                {/* In-app player: mpv handles anything, including a
                    multi-file torrent's folder (loaded as a playlist). */}
                {playerAvailable && item.filePath && (
                  <button type="button" onClick={() => playInPrism(item.filePath!, item.metadata.title)} title="Play in Prism" aria-label="Play in Prism" className={iconButton}>
                    <MonitorPlay className="w-3.5 h-3.5" />
                  </button>
                )}
                {/* Multi-file torrents resolve to a folder the OS can't
                    "play" — Show in Folder covers those. */}
                {!isTorrent && item.filePath && (
                  <button
                    type="button"
                    onClick={() => service.openFile(item.filePath!).catch((e) => toast.error(e instanceof Error ? e.message : String(e)))}
                    title="Open in default player"
                    aria-label="Open in default player"
                    className={iconButton}
                  >
                    <Play className="w-3.5 h-3.5" />
                  </button>
                )}
                {revealTarget && (
                  <button
                    type="button"
                    onClick={() => service.showInFolder(revealTarget).catch(() => toast.error('File not found — it may have been moved or deleted'))}
                    title="Show in folder"
                    aria-label="Show in folder"
                    className={iconButton}
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => service.copyToClipboard(item.metadata.source.url).then(() => toast.success('URL copied')).catch(() => toast.error('Copy failed'))}
                  title="Copy source URL"
                  aria-label="Copy source URL"
                  className={iconButton}
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </>
            );
          })()}
          {/* Failed rows retry from their failure note. */}
          {!isFailed && (
            <button type="button" onClick={() => onRequeue(item)} title="Download again" aria-label="Download again" className={iconButton}>
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            title="Remove from library"
            aria-label="Remove from library"
            className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-destructive transition-colors active:scale-[0.95]"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
});
