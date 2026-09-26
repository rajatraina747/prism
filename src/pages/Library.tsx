import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useHistory, useQueue, useSettings } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { EmptyState, Thumb, ConfirmDialog, BulkButton } from '@/components/common';
import { sortHistory, gridColumns, LIBRARY_SORTS, trashTarget, baseName } from '@/stores/library';
import { FailureNote } from '@/components/common/FailureNote';
import { VirtualList } from '@/components/common/VirtualList';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatBytes, generateId, isTorrentUrl, isDirectFileUrl } from '@/services';
import { categoriesInUse, labelsInUse, nextSelection } from '@/stores/transfers';
import {
  Clock, Search, Trash2, ListX, CheckCircle2, XCircle, Ban, RotateCcw,
  LayoutGrid, Rows3, ArrowUpDown, AlignJustify,
  FolderOpen, Play, Copy, AlertTriangle, MonitorPlay, ChevronRight, Tag, Tags, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { HistoryItem, ListDensity } from '@/types/models';

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
  const { items, removeFromHistory, restoreHistory, clearHistory } = useHistory();
  const { addToQueue } = useQueue();
  const { preferences, updatePreference } = useSettings();
  const [tab, setTab] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmTrash, setConfirmTrash] = useState(false);
  // Torrent row whose per-file list is expanded (one at a time keeps it tidy).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Multi-select, using the same click/shift/meta rules as Transfers rather
  // than a second selection model that would drift from it.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const playerAvailable = usePlayerAvailable();
  // The page needs its own handle: the one in LibraryRow is that row's, and
  // reaching for it from here bound to the imported module instead — which
  // typechecked, and took the whole page down at render.
  const service = useService();

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
  const labels = useMemo(() => labelsInUse(items, preferences.labels), [items, preferences.labels]);
  const activeLabel = label && labels.some(l => l.id === label) ? label : null;
  const labelNames = useMemo(
    () => Object.fromEntries(preferences.labels.map(l => [l.id, l.name])),
    [preferences.labels],
  );
  // Rows whose file has been moved or deleted outside Prism, checked when
  // the Library opens and whenever it changes.
  const [missing, setMissing] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const withFiles = items.filter(i => i.status === 'completed' && i.filePath).slice(0, 5000);
    if (withFiles.length === 0) { setMissing(new Set()); return; }
    let live = true;
    service.missingFiles(withFiles.map(i => i.filePath!))
      .then(flags => { if (live) setMissing(new Set(withFiles.filter((_, n) => flags[n]).map(i => i.id))); })
      .catch(() => { /* a convenience: rows just don't say */ });
    return () => { live = false; };
  }, [items, service]);
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return inTab.filter(i =>
      (!activeCategory || i.settings.categoryId === activeCategory)
      && (!activeLabel || (i.settings.labelIds?.includes(activeLabel) ?? false))
      && (!q || i.metadata.title.toLowerCase().includes(q)));
  }, [inTab, search, activeCategory, activeLabel]);

  const sorted = useMemo(
    () => sortHistory(filtered, preferences.librarySort),
    [filtered, preferences.librarySort],
  );

  // Columns come from the list's real width rather than a breakpoint guess, so
  // a narrow window gets one readable column instead of three cramped ones.
  const listRef = React.useRef<HTMLDivElement>(null);
  const [listWidth, setListWidth] = useState(0);
  React.useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => setListWidth(entries[0].contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const columns = preferences.libraryView === 'grid' ? gridColumns(listWidth) : 1;

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

  // Follows the order on screen, so shift-select picks the run the user sees.
  const orderedIds = useMemo(() => sorted.map(i => i.id), [sorted]);
  const onSelect = useCallback((id: string, mods: { shift: boolean; meta: boolean }) => {
    setSelected(cur => {
      const next = nextSelection(cur, anchor, orderedIds, id, mods);
      setAnchor(next.anchor);
      return next.selection;
    });
  }, [anchor, orderedIds]);
  // Only what is both selected and currently visible: a filter or tab change
  // shouldn't act on rows the user can no longer see.
  const selectedItems = useMemo(() => sorted.filter(i => selected.has(i.id)), [sorted, selected]);
  const clearSelection = useCallback(() => { setSelected(new Set()); setAnchor(null); }, []);

  const revealSelected = useCallback(() => {
    for (const item of selectedItems) {
      const target = item.filePath ?? item.outputFolder ?? item.settings.destination;
      if (target) service.showInFolder(target).catch(() => {});
    }
  }, [selectedItems, service]);

  const removeSelected = useCallback(() => {
    const count = selectedItems.length;
    const removed = selectedItems;
    removed.forEach(i => removeFromHistory(i.id));
    clearSelection();
    // Records only — the files are untouched, so an undo can simply put the
    // entries back rather than having to restore anything from disk.
    toast(`Removed ${count} ${count === 1 ? 'entry' : 'entries'} from the library`, {
      action: { label: 'Undo', onClick: () => removed.forEach(restoreHistory) },
      duration: 8000,
    });
  }, [selectedItems, removeFromHistory, restoreHistory, clearSelection]);

  // A real file, or a torrent's own folder, never the folder a download was
  // saved into (see trashTarget): that is the whole download folder, and
  // trashing it would take every other download with it.
  const trashable = useMemo(
    () => selectedItems.flatMap(i => {
      const target = trashTarget(i);
      return target ? [{ item: i, ...target }] : [];
    }),
    [selectedItems],
  );
  const trashTargets = useMemo(() => trashable.map(t => t.path), [trashable]);
  const trashFolders = useMemo(() => trashable.filter(t => t.folder).map(t => baseName(t.path)), [trashable]);

  const trashSelected = useCallback(async () => {
    setConfirmTrash(false);
    const removed = trashable.map(t => t.item);
    try {
      const count = await service.moveToTrash(trashTargets);
      removed.forEach(i => removeFromHistory(i.id));
      clearSelection();
      // No Undo offered: the files are in the OS Trash now, and restoring the
      // entries would leave them pointing at paths that have moved. The Trash
      // itself is the undo.
      toast.success(`Moved ${count} ${count === 1 ? 'item' : 'items'} to the Trash`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not move those to the Trash');
    }
  }, [trashable, trashTargets, service, removeFromHistory, clearSelection]);

  return (
    <div className="page-container">
      <div className="flex items-center justify-between page-header">
        <div>
          <h2 className="page-title">Library</h2>
          <p className="page-subtitle">Completed, failed, and canceled downloads</p>
        </div>
        <div className="flex items-center gap-2">
          {items.length > 0 && (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-secondary hover:text-secondary-foreground transition-colors"
                    aria-label="Sort library"
                  >
                    <ArrowUpDown className="w-3 h-3" />
                    {LIBRARY_SORTS.find(s => s.id === preferences.librarySort)?.label ?? 'Newest'}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  {LIBRARY_SORTS.map(s => (
                    <DropdownMenuItem
                      key={s.id}
                      onSelect={() => updatePreference('librarySort', s.id)}
                      className={cn('text-xs', preferences.librarySort === s.id && 'text-primary')}
                    >
                      {s.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <button
                type="button"
                onClick={() => updatePreference('libraryView', preferences.libraryView === 'grid' ? 'list' : 'grid')}
                aria-label={preferences.libraryView === 'grid' ? 'Show as a list' : 'Show as a grid'}
                title={preferences.libraryView === 'grid' ? 'Show as a list' : 'Show as a grid'}
                className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary hover:text-secondary-foreground transition-colors"
              >
                {preferences.libraryView === 'grid'
                  ? <Rows3 className="w-3.5 h-3.5" />
                  : <LayoutGrid className="w-3.5 h-3.5" />}
              </button>

              <button
                type="button"
                onClick={() => updatePreference('listDensity', preferences.listDensity === 'compact' ? 'comfortable' : 'compact')}
                aria-label={preferences.listDensity === 'compact' ? 'Use comfortable spacing' : 'Use compact spacing'}
                title={preferences.listDensity === 'compact' ? 'Use comfortable spacing' : 'Use compact spacing'}
                aria-pressed={preferences.listDensity === 'compact'}
                className={cn(
                  'p-1.5 rounded-lg transition-colors hover:bg-secondary hover:text-secondary-foreground',
                  preferences.listDensity === 'compact' ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                <AlignJustify className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          {inTab.length > 0 && (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
            >
              <ListX className="w-3 h-3" /> {tab === 'all' ? 'Clear All' : `Clear ${TAB_LABELS[tab]}`}
            </button>
          )}
        </div>
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
            {labels.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-secondary hover:text-secondary-foreground transition-colors" aria-label="Filter by label">
                    <Tags className="w-3 h-3" />
                    {activeLabel ? labels.find(l => l.id === activeLabel)?.name : 'All labels'}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  <DropdownMenuItem onSelect={() => setLabel(null)} className={cn('text-xs', !activeLabel && 'text-primary')}>All labels</DropdownMenuItem>
                  {labels.map(l => (
                    <DropdownMenuItem key={l.id} onSelect={() => setLabel(l.id)} className={cn('text-xs', activeLabel === l.id && 'text-primary')}>{l.name || 'Unnamed'}</DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}

        {selectedItems.length > 1 && (
          <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-lg bg-primary/8 border border-primary/20 text-xs animate-fade-in">
            <span className="text-foreground tabular-nums">{selectedItems.length} selected</span>
            <BulkButton icon={RotateCcw} label="Download again" onClick={() => selectedItems.forEach(requeue)} />
            <BulkButton icon={FolderOpen} label="Show in folder" onClick={revealSelected} />
            <BulkButton icon={ListX} label="Remove" onClick={removeSelected} />
            {trashTargets.length > 0 && (
              <BulkButton icon={Trash2} label="Move to Trash" onClick={() => setConfirmTrash(true)} />
            )}
            <button
              onClick={clearSelection}
              aria-label="Clear selection"
              className="ml-auto p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <TabsContent ref={listRef} value={tab} className="mt-0 focus-visible:ring-0 focus-visible:ring-offset-0">
          {sorted.length === 0 ? (
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
              items={sorted}
              getKey={item => item.id}
              columns={columns}
              // A grid cell leads with a thumbnail and is much taller than a
              // row, so the estimate has to follow the layout — a fixed one
              // would leave the windowing maths wrong in whichever mode it
              // wasn't measured for.
              estimateSize={columns > 1 ? 188 : preferences.listDensity === 'compact' ? 48 : 64}
              gap={6}
              aria-label={`${TAB_LABELS[tab]} downloads`}
              role="listbox"
              aria-multiselectable
              renderItem={item => (
                <LibraryRow
                  item={item}
                  density={preferences.listDensity}
                  grid={columns > 1}
                  expanded={expandedId === item.id}
                  playerAvailable={playerAvailable}
                  labelNames={labelNames}
                  missing={missing.has(item.id)}
                  selected={selected.has(item.id)}
                  onSelect={onSelect}
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

      <ConfirmDialog
        open={confirmTrash}
        onOpenChange={setConfirmTrash}
        title={`Move ${trashTargets.length} ${trashTargets.length === 1 ? 'download' : 'downloads'} to the Trash?`}
        description={[
          'The files go to your system Trash, where you can put them back. Their library entries are removed too.',
          trashFolders.length > 0
            ? `${trashFolders.length === 1 ? 'This folder goes' : 'These folders go'} with everything in ${trashFolders.length === 1 ? 'it' : 'them'}: ${trashFolders.map(n => `“${n}”`).join(', ')}.`
            : '',
          selectedItems.length > trashTargets.length
            ? `${selectedItems.length - trashTargets.length} selected ${selectedItems.length - trashTargets.length === 1 ? 'item has' : 'items have'} no file of its own on disk and will be left alone.`
            : '',
        ].join(' ').trim()}
        confirmLabel="Move to Trash"
        destructive
        onConfirm={trashSelected}
      />
    </div>
  );
}

const LibraryRow = React.memo(function LibraryRow({
  item, expanded, playerAvailable, labelNames, selected, density = 'comfortable', grid = false,
  onSelect, onToggleExpanded, onRequeue, onRemove, missing = false,
}: {
  item: HistoryItem;
  /** Its file has been moved or deleted outside Prism. */
  missing?: boolean;
  expanded: boolean;
  playerAvailable: boolean;
  labelNames?: Record<string, string>;
  density?: ListDensity;
  /** Laid out as a grid cell: thumbnail on top, details under it. */
  grid?: boolean;
  selected?: boolean;
  onSelect?: (id: string, mods: { shift: boolean; meta: boolean }) => void;
  onToggleExpanded: (id: string) => void;
  onRequeue: (item: HistoryItem) => void;
  onRemove: (id: string) => void;
}) {
  const service = useService();
  const isTorrent = isTorrentUrl(item.metadata.source.url);
  const isFailed = item.status === 'failed';

  // A click on one of the row's own controls is that control's, not a
  // selection — the same rule the Transfers rows follow.
  const handleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, a, [role="button"]')) return;
    onSelect?.(item.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
  };

  return (
    <div
      role="option"
      aria-selected={!!selected}
      onClick={handleClick}
      className={cn(
        'surface-row rounded-xl',
        density === 'compact' ? 'p-2' : 'p-3',
        selected && 'ring-1 ring-primary/60 bg-primary/5',
      )}
    >
      {/* A grid cell leads with the picture, which is the useful handle for
          finished video; a row leads with the title. */}
      <div className={grid ? 'flex flex-col gap-2' : 'flex items-start gap-3'}>
        {isFailed ? (
          <div className={cn(
            'rounded-lg bg-destructive/10 flex items-center justify-center shrink-0',
            grid ? 'w-full h-24' : 'w-8 h-8 mt-0.5',
          )}>
            <AlertTriangle className="w-4 h-4 text-destructive" aria-hidden="true" />
          </div>
        ) : (
          <Thumb
            src={item.metadata.thumbnail}
            className={grid ? 'w-full h-24' : 'w-[72px] h-10'}
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
                return <span className="text-warning" title={`Requested ${requested}, the site delivered ${actual}`}>{actual} (asked {requested})</span>;
              }
              const label = actual ?? requested;
              return label ? <span>{label}</span> : null;
            })()}
            {item.settings.audioOnly && <span>Audio</span>}
            {item.settings.categoryName && (
              <span className="px-1.5 rounded bg-secondary text-secondary-foreground">{item.settings.categoryName}</span>
            )}
            {item.settings.labelIds?.map(id => labelNames?.[id]).filter(Boolean).map(name => (
              <span key={name} className="px-1.5 rounded bg-primary/10 text-primary/90">{name}</span>
            ))}
            {item.seeding && (
              <span className="px-1.5 rounded bg-primary/10 text-primary/90" title="Finished downloading and still uploading to others; see Transfers">Seeding</span>
            )}
            {missing && (
              <span className="px-1.5 rounded bg-destructive/10 text-destructive" title="The file has been moved or deleted outside Prism">Missing</span>
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
            <ListX className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
});
