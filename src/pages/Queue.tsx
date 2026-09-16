import React, { useCallback, useMemo, useState } from 'react';
import { useQueue, useHistory, useSettings } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { QueueTable, type SelectMods } from '@/components/queue/QueueTable';
import { DetailPanel } from '@/components/queue/DetailPanel';
import { SessionFooter } from '@/components/queue/SessionFooter';
import { EmptyState, ConfirmDialog } from '@/components/common';
import { QuietHoursBanner, useMinuteClock } from '@/components/common/QuietHoursBanner';
import { quietHoursStatus } from '@/stores/schedule';
import { formatSpeed } from '@/services';
import { FILTERS, SORTS, filterCounts, visibleTransfers, nextSelection, isTransfer, categoriesInUse } from '@/stores/transfers';
import { useTransferShortcuts, type TransferShortcutHandlers } from '@/hooks/use-transfer-shortcuts';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ArrowDownToLine, Pause, Play, Search, ArrowUpDown, RefreshCw, Trash2, Tag, X } from 'lucide-react';
import type { TransfersFilter, TransfersSort } from '@/types/models';

export default function Queue() {
  const {
    items, addToQueue, pauseDownload, resumeDownload, cancelDownload, retryDownload, removeFromQueue,
    startAll, pauseAll, reorderQueue, updateTorrentFiles, setItemCategory, setItemLabels, reannounceTorrent, recheckTorrent, removeWithData,
    moveToTop, moveToBottom,
  } = useQueue();
  const { removeFromHistory } = useHistory();
  const { preferences, updatePreference } = useSettings();
  const service = useService();

  // Cancel is a single click on a possibly hours-old download — no confirm
  // dialog, but give a few seconds to undo (undo restarts from the top).
  const cancelWithUndo = useCallback((id: string) => {
    const item = items.find(i => i.id === id);
    if (item?.status === 'seeding') {
      cancelDownload(id);
      return;
    }
    cancelDownload(id);
    toast(`Canceled: ${item?.metadata.title ?? 'download'}`, {
      action: {
        label: 'Undo',
        onClick: () => {
          if (!item) return;
          removeFromQueue(id);
          removeFromHistory(id);
          addToQueue({ ...item, status: 'queued', progress: 0, speed: 0, eta: 0, downloadedBytes: 0, error: undefined });
        },
      },
      duration: 6000,
    });
  }, [items, cancelDownload, removeFromQueue, removeFromHistory, addToQueue]);

  const [search, setSearch] = useState('');
  // Kept local, like the search box: a filter you can't see the effect of is
  // worse after a restart than a fresh list.
  const [category, setCategory] = useState<string | null>(null);
  const filter = preferences.transfersFilter;
  const sort = preferences.transfersSort;
  const setFilter = (f: TransfersFilter) => updatePreference('transfersFilter', f);
  const setSort = (s: TransfersSort) => updatePreference('transfersSort', s);

  const now = useMinuteClock();
  const quiet = quietHoursStatus(preferences, now);
  const activeItems = useMemo(() => items.filter(isTransfer), [items]);
  const counts = useMemo(() => filterCounts(activeItems), [activeItems]);
  const categories = useMemo(() => categoriesInUse(activeItems), [activeItems]);
  const labelNames = useMemo(
    () => Object.fromEntries(preferences.labels.map(l => [l.id, l.name])),
    [preferences.labels],
  );
  // Heal the filter when its last transfer is archived, rather than leaving
  // the list mysteriously empty under a category that is no longer there.
  const activeCategory = category && categories.some(c => c.id === category) ? category : null;
  const visibleItems = useMemo(
    () => visibleTransfers(items, filter, sort, search, activeCategory),
    [items, filter, sort, search, activeCategory],
  );
  const orderedIds = useMemo(() => visibleItems.map(i => i.id), [visibleItems]);

  // Reorder only under "Added" order with no search: any other view maps
  // visible indexes onto a different order than the queue's.
  const canReorder = sort === 'added' && !search && filter === 'all' && !activeCategory;
  const reorderVisible = useCallback((fromIndex: number, toIndex: number) => {
    const fromId = visibleItems[fromIndex]?.id;
    const toId = visibleItems[toIndex]?.id;
    const from = items.findIndex(i => i.id === fromId);
    const to = items.findIndex(i => i.id === toId);
    if (from !== -1 && to !== -1) reorderQueue(from, to);
  }, [items, visibleItems, reorderQueue]);

  // Selection + detail panel.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const onSelect = useCallback((id: string, mods: SelectMods) => {
    setSelected(cur => {
      const next = nextSelection(cur, anchor, orderedIds, id, mods);
      setAnchor(next.anchor);
      return next.selection;
    });
  }, [anchor, orderedIds]);
  const selectedItems = useMemo(() => visibleItems.filter(i => selected.has(i.id)), [visibleItems, selected]);
  const detailItem = selectedItems.length === 1 ? selectedItems[0] : null;

  // Player availability for the Files tab actions.
  const [playerAvailable, setPlayerAvailable] = useState(false);
  React.useEffect(() => {
    import('@tauri-apps/api/core')
      .then(({ isTauri, invoke }) => (isTauri() ? invoke<boolean>('player_available') : false))
      .then(setPlayerAvailable)
      .catch(() => {});
  }, []);

  const showInFolder = useCallback((id: string) => {
    const item = items.find(i => i.id === id);
    if (!item) return;
    service.showInFolder(item.filePath ?? item.settings.destination ?? '~/Downloads/Prism')
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
  }, [items, service]);

  const forSelection = useCallback((fn: (id: string) => void) => selectedItems.forEach(i => fn(i.id)), [selectedItems]);

  const shortcuts = useMemo<TransferShortcutHandlers>(() => ({
    moveSelection: (delta) => {
      if (orderedIds.length === 0) return;
      const currentIdx = anchor ? orderedIds.indexOf(anchor) : -1;
      const nextIdx = Math.min(orderedIds.length - 1, Math.max(0, currentIdx + delta));
      const id = orderedIds[nextIdx];
      setSelected(new Set([id]));
      setAnchor(id);
    },
    selectAll: () => { setSelected(new Set(orderedIds)); },
    togglePauseSelected: () => {
      forSelection(id => {
        const it = items.find(i => i.id === id);
        if (!it) return;
        if (it.status === 'downloading' || it.status === 'seeding' || it.status === 'queued') pauseDownload(id);
        else if (it.status === 'paused') resumeDownload(id);
      });
    },
    toggleDetails: () => { if (detailItem) setDetailsOpen(o => !o); },
    removeSelected: () => { if (selectedItems.length > 0) setConfirmRemove(true); },
    updateTracker: () => {
      const torrents = selectedItems.filter(i => i.kind === 'torrent' && (i.status === 'downloading' || i.status === 'seeding'));
      torrents.forEach(i => reannounceTorrent(i.id));
    },
    clearSelection: () => { setSelected(new Set()); setDetailsOpen(false); },
  }), [orderedIds, anchor, forSelection, items, pauseDownload, resumeDownload, detailItem, selectedItems, reannounceTorrent]);
  useTransferShortcuts(shortcuts);

  const downloading = items.filter(i => i.status === 'downloading');
  const hasActive = downloading.length > 0 || items.some(i => i.status === 'seeding');
  const hasPaused = items.some(i => i.status === 'paused' || i.status === 'queued');
  const hasTorrents = activeItems.some(i => i.kind === 'torrent');
  const totalSpeed = downloading.reduce((sum, i) => sum + (i.speed || 0), 0);
  const subtitle = [
    `${activeItems.length} transfer${activeItems.length !== 1 ? 's' : ''}`,
    downloading.length > 0 && `${downloading.length} downloading`,
    totalSpeed > 0 && formatSpeed(totalSpeed),
  ].filter(Boolean).join(' · ');

  const removeSelectedNow = () => {
    selectedItems.forEach(i => {
      if (i.status === 'downloading' || i.status === 'seeding' || i.status === 'paused' || i.status === 'queued') cancelDownload(i.id);
      else removeFromQueue(i.id);
    });
    setSelected(new Set());
    setConfirmRemove(false);
  };

  return (
    <div className="page-container flex flex-col">
      <div className="flex items-center justify-between page-header">
        <div>
          <h2 className="page-title">Transfers</h2>
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

      <QuietHoursBanner className="mb-3" />

      {/* `contents` keeps the page's flex layout: the Tabs root only ties the
          filter tabs to the list panel for assistive tech. */}
      <Tabs value={filter} onValueChange={(v) => setFilter(v as TransfersFilter)} className="contents">
      {/* Filter tabs + sort + search */}
      {activeItems.length > 0 && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <TabsList aria-label="Filter transfers" className="h-auto gap-1 bg-transparent p-0">
            {FILTERS.map(f => (
              <TabsTrigger
                key={f.id}
                value={f.id}
                className={cn(
                  'px-2.5 py-1 rounded-lg text-xs font-medium transition-colors',
                  'text-muted-foreground hover:bg-secondary hover:text-secondary-foreground',
                  'data-[state=active]:bg-primary/12 data-[state=active]:text-primary data-[state=active]:shadow-none',
                  counts[f.id] === 0 && filter !== f.id && 'opacity-50',
                )}
              >
                {f.label}<span className="ml-1 tabular-nums opacity-60">{counts[f.id]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-muted-foreground hover:bg-secondary hover:text-secondary-foreground transition-colors" aria-label="Sort transfers">
                <ArrowUpDown className="w-3 h-3" /> {SORTS.find(s => s.id === sort)?.label}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-40">
              {SORTS.map(s => (
                <DropdownMenuItem key={s.id} onSelect={() => setSort(s.id)} className={cn('text-xs', sort === s.id && 'text-primary')}>{s.label}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {categories.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-muted-foreground hover:bg-secondary hover:text-secondary-foreground transition-colors" aria-label="Filter by category">
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
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-input border border-border/40 ml-auto w-56">
            <Search className="w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Filter transfers…"
              aria-label="Filter transfers"
              className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/50 outline-none min-w-0"
            />
          </div>
        </div>
      )}

      {/* Bulk action bar */}
      {selectedItems.length > 1 && (
        <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-lg bg-primary/8 border border-primary/20 text-xs animate-fade-in">
          <span className="text-foreground tabular-nums">{selectedItems.length} selected</span>
          <BulkButton icon={Pause} label="Pause" onClick={() => forSelection(id => { const it = items.find(i => i.id === id); if (it && (it.status === 'downloading' || it.status === 'seeding' || it.status === 'queued')) pauseDownload(id); })} />
          <BulkButton icon={Play} label="Resume" onClick={() => forSelection(id => { const it = items.find(i => i.id === id); if (it?.status === 'paused') resumeDownload(id); })} />
          {selectedItems.some(i => i.kind === 'torrent') && (
            <BulkButton icon={RefreshCw} label="Update tracker" onClick={shortcuts.updateTracker} />
          )}
          <BulkButton icon={Trash2} label="Remove" onClick={() => setConfirmRemove(true)} />
          <button onClick={() => setSelected(new Set())} aria-label="Clear selection" className="ml-auto p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col">
        {activeItems.length === 0 ? (
          <EmptyState
            icon={ArrowDownToLine}
            title="No transfers"
            description="Downloads and torrents you add will appear here. Paste a URL or magnet link on the Dashboard to get started."
          />
        ) : visibleItems.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No matches"
            description={search ? `Nothing matches “${search}”.` : `Nothing is ${FILTERS.find(f => f.id === filter)?.label.toLowerCase()} right now.`}
          />
        ) : (
          <TabsContent value={filter} className="flex-1 min-h-0 overflow-auto mt-0 focus-visible:ring-0 focus-visible:ring-offset-0">
            <QueueTable
              items={visibleItems}
              heldUntil={quiet?.mode === 'pause' ? quiet.until : undefined}
              labelNames={labelNames}
              selectedIds={selected}
              onSelect={onSelect}
              onPause={pauseDownload}
              onResume={resumeDownload}
              onCancel={cancelWithUndo}
              onRetry={retryDownload}
              onRemove={removeFromQueue}
              onReorder={canReorder ? reorderVisible : undefined}
              onUpdateFiles={updateTorrentFiles}
              onReannounce={reannounceTorrent}
              onRecheck={recheckTorrent}
              onRemoveWithData={(id) => setConfirmDelete(id)}
              onMoveTop={canReorder ? moveToTop : undefined}
              onMoveBottom={canReorder ? moveToBottom : undefined}
              onShowInFolder={showInFolder}
              onOpenDetails={(id) => { setSelected(new Set([id])); setAnchor(id); setDetailsOpen(true); }}
            />
          </TabsContent>
        )}

        {detailsOpen && detailItem && (
          <DetailPanel
            item={detailItem}
            height={preferences.detailPanelHeight}
            onHeightChange={(h) => updatePreference('detailPanelHeight', h)}
            onClose={() => setDetailsOpen(false)}
            onUpdateFiles={updateTorrentFiles}
            onReannounce={reannounceTorrent}
            onSetCategory={setItemCategory}
            onSetLabels={setItemLabels}
            playerAvailable={playerAvailable}
          />
        )}

        <SessionFooter hasTorrents={hasTorrents} />
      </div>
      </Tabs>

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}
        title="Remove torrent and delete its files?"
        description={`This stops "${items.find(i => i.id === confirmDelete)?.metadata.title ?? 'the torrent'}" and permanently deletes everything it downloaded. This cannot be undone.`}
        confirmLabel="Delete files"
        destructive
        onConfirm={() => { if (confirmDelete) removeWithData(confirmDelete); setConfirmDelete(null); setSelected(new Set()); }}
      />
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${selectedItems.length} transfer${selectedItems.length === 1 ? '' : 's'}?`}
        description="Active transfers are cancelled; downloaded data stays on disk."
        confirmLabel="Remove"
        destructive
        onConfirm={removeSelectedNow}
      />
    </div>
  );
}

function BulkButton({ icon: Icon, label, onClick }: { icon: React.ElementType; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1 px-2 py-1 rounded-md bg-secondary text-[11px] text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]">
      <Icon className="w-3 h-3" /> {label}
    </button>
  );
}
