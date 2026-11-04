import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useHistory, useQueueActions, useSettings } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { EmptyState, EmptyActions, Thumb, ConfirmDialog, BulkButton } from '@/components/common';
import { torrentFilePath } from '@/stores/torrent-item';
import { sortHistory, gridColumns, LIBRARY_SORTS, trashTarget, baseName } from '@/stores/library';
import { FailureNote } from '@/components/common/FailureNote';
import { VirtualList } from '@/components/common/VirtualList';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatBytes, isTorrentUrl, isDirectFileUrl } from '@/services';
import { categoriesInUse, labelsInUse, nextSelection } from '@/stores/transfers';
import {
  Clock, Search, Trash2, ListX, CheckCircle2, XCircle, Ban, RotateCcw,
  LayoutGrid, Rows3, ArrowUpDown, AlignJustify,
  FolderOpen, Play, Copy, AlertTriangle, MonitorPlay, ChevronRight, Tag, Tags, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { usePlayerAvailable } from '@/hooks/use-player-available';
import { useFindShortcut } from '@/hooks/use-find-shortcut';
import { ActivityPanel } from '@/components/library/Activity';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { TRASH_NAME } from '@/lib/platform';
import type { HistoryItem, ListDensity } from '@/types/models';
import { buildItem } from '@/stores/build-item';

/** The Library shows finished media ('media'); what didn't finish (failed
 * and cancelled) is the same list in 'attention' mode, shown under
 * Downloads → Needs attention (2.6 redesign). */
type Mode = 'media' | 'attention';
type FilterTab = 'all' | 'video' | 'audio' | 'torrent' | 'missing' | 'failed' | 'canceled';

const TAB_LABELS: Record<FilterTab, string> = {
  all: 'All',
  video: 'Video',
  audio: 'Audio',
  torrent: 'Torrents',
  missing: 'Missing',
  failed: 'Failed',
  canceled: 'Cancelled',
};

const MODE_TABS: Record<Mode, FilterTab[]> = {
  media: ['all', 'video', 'audio', 'torrent', 'missing'],
  attention: ['all', 'failed', 'canceled'],
};

function inMode(item: HistoryItem, mode: Mode): boolean {
  return mode === 'media' ? item.status === 'completed' : item.status === 'failed' || item.status === 'canceled';
}

/** What a finished download is, for the Library's tabs. */
function mediaKind(item: HistoryItem): 'video' | 'audio' | 'torrent' {
  if (isTorrentUrl(item.metadata.source.url)) return 'torrent';
  if (item.settings.audioOnly) return 'audio';
  return 'video';
}

function matchesTab(item: HistoryItem, tab: FilterTab, missing: Set<string>): boolean {
  switch (tab) {
    case 'all': return true;
    case 'video': case 'audio': case 'torrent': return mediaKind(item) === tab;
    case 'missing': return missing.has(item.id);
    default: return item.status === tab;
  }
}

/** A torrent's files with their own Play / Open / Show buttons. Inline in
 * list view; in grid view it opens in a dialog, so the card keeps its size. */
function TorrentFiles({ item, playerAvailable }: { item: HistoryItem; playerAvailable: boolean }) {
  const service = useService();
  return (
    <ul className="mt-1 space-y-0.5">
      {(item.files ?? []).map((f) => (
        <li key={f.name} className="flex items-center gap-2 text-xs text-muted-foreground group">
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
  );
}

/** No search box: the embedded Needs attention list leaves ⌘F to its page. */
const NO_INPUT = { current: null };

/** Height of every grid card; the grid's size estimate uses it too. */
const GRID_CARD_HEIGHT = 228;

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function playAFile() {
  import('@/lib/player-window')
    .then(({ pickAndPlay }) => pickAndPlay())
    .catch((e) => toast.error(`Couldn't play that file: ${e instanceof Error ? e.message : e}`));
}

function playInPrism(path: string, title: string) {
  // Dynamic import keeps the Tauri window APIs out of the web-demo bundle path.
  import('@/lib/player-window')
    .then(({ openInPlayer }) => openInPlayer({ path, title }))
    .catch((e) => toast.error(`Couldn't open the player: ${e instanceof Error ? e.message : e}`));
}

const iconButton = 'p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]';

function statusIcon(status: string) {
  if (status === 'completed') return <CheckCircle2 className="w-3 h-3 text-success" aria-label="Completed" />;
  if (status === 'failed') return <XCircle className="w-3 h-3 text-destructive" aria-label="Failed" />;
  return <Ban className="w-3 h-3 text-muted-foreground" aria-label="Cancelled" />;
}

/** One page for everything that has finished, one way or another: completed,
 * failed, and canceled downloads, in tabs. Replaces the old Downloads / Failed /
 * History trio, which showed the same records three ways. Long libraries are
 * windowed — only the rows near the viewport are mounted. */
export default function Library() {
  return <LibraryView mode="media" />;
}

/** "Play a file": the picker, and the files played recently (which play
 * again from wherever they are; Rust kept the list). */
function PlayFileMenu() {
  const [recent, setRecent] = useState<import('@/lib/player-window').RecentMedia[]>([]);
  const load = () => {
    import('@/lib/player-window').then(m => m.recentMedia()).then(setRecent).catch(() => setRecent([]));
  };
  return (
    <DropdownMenu onOpenChange={(o) => { if (o) load(); }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Play any audio or video file on this computer (⌘O)"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
        >
          <FolderOpen className="w-3 h-3" /> Play a file
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem onSelect={playAFile} className="text-xs">Choose a file…</DropdownMenuItem>
        {recent.length > 0 && (
          <>
            <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">Recent</div>
            {recent.map(r => (
              <DropdownMenuItem key={r.path} onSelect={() => playInPrism(r.path, r.title)} className="text-xs" title={r.path}>
                <span className="truncate">{r.title}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              onSelect={() => import('@/lib/player-window').then(m => m.clearRecentMedia()).then(() => setRecent([])).catch(() => {})}
              className="text-xs text-muted-foreground"
            >
              Clear recent files
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The Activity strip opens when you arrive from the old Statistics page. */
function LibraryActivity() {
  const [params] = useSearchParams();
  return <ActivityPanel defaultOpen={params.get('activity') === '1'} />;
}

export function LibraryView({ mode, embedded = false }: { mode: Mode; embedded?: boolean }) {
  const { items: allItems, removeFromHistory, restoreHistory } = useHistory();
  const items = useMemo(() => allItems.filter(i => inMode(i, mode)), [allItems, mode]);
  const { addToQueue } = useQueueActions();
  const { preferences, updatePreference } = useSettings();
  const [tab, setTab] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  // Only the page's own Library list, not the embedded Needs attention one.
  useFindShortcut(embedded ? NO_INPUT : searchRef);
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
    addToQueue(buildItem({
      metadata: item.metadata,
      // Queued again now, whatever it was held for then.
      settings: { ...item.settings, startImmediately: true },
      totalBytes: item.totalBytes || item.settings.format?.fileSize,
      kind: isTorrentUrl(item.metadata.source.url)
        ? 'torrent'
        : isDirectFileUrl(item.metadata.source.url) ? 'direct' : undefined,
    }));
    if (item.status === 'failed') removeFromHistory(item.id);
    toast.success(`${item.status === 'failed' ? 'Retrying' : 'Queued again'}: ${item.metadata.title}`);
  }, [addToQueue, removeFromHistory]);

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
  // Keyed on the files themselves, not the list object: every Library change
  // (a label, a removal) sent up to 5,000 paths to be checked again, even
  // when none of them changed. Debounced so a burst of finishes is one check
  // (REVIEW 2026-09-28 P-11).
  const withFiles = useMemo(
    () => items.filter(i => i.status === 'completed' && i.filePath).slice(0, 5000),
    [items],
  );
  const filesKey = useMemo(() => withFiles.map(i => `${i.id}\u0000${i.filePath}`).join('\n'), [withFiles]);
  const withFilesRef = useRef(withFiles);
  withFilesRef.current = withFiles;
  useEffect(() => {
    const rows = withFilesRef.current;
    if (rows.length === 0) { setMissing(new Set()); return; }
    let live = true;
    const timer = setTimeout(() => {
      service.missingFiles(rows.map(i => i.filePath!))
        .then(flags => { if (live) setMissing(new Set(rows.filter((_, n) => flags[n]).map(i => i.id))); })
        .catch(() => { /* a convenience: rows just don't say */ });
    }, 500);
    return () => { live = false; clearTimeout(timer); };
  }, [filesKey, service]);
  const inTab = useMemo(() => items.filter(i => matchesTab(i, tab, missing)), [items, tab, missing]);
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

  const tabs = MODE_TABS[mode]
    .map(key => ({ key, label: TAB_LABELS[key], count: items.filter(i => matchesTab(i, key, missing)).length }))
    // An empty Missing tab is noise; the others stay so the layout is steady.
    .filter(t => t.key !== 'missing' || t.count > 0 || tab === 'missing');

  // Only this mode's entries in this tab: the Library's Clear never removes
  // what's waiting under Needs attention, or the other way round.
  const clearCurrent = useCallback(() => {
    inTab.forEach(i => removeFromHistory(i.id));
  }, [inTab, removeFromHistory]);

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
  // Never a Missing row: its file is already gone, and one missing path made
  // the whole all-or-nothing request fail (Windows test run 2026-09-26).
  const trashable = useMemo(
    () => selectedItems.flatMap(i => {
      const target = missing.has(i.id) ? undefined : trashTarget(i);
      return target ? [{ item: i, ...target }] : [];
    }),
    [selectedItems, missing],
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
      toast.success(`Moved ${count} ${count === 1 ? 'item' : 'items'} to the ${TRASH_NAME}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not move those to the ${TRASH_NAME}`);
    }
  }, [trashable, trashTargets, service, removeFromHistory, clearSelection]);

  return (
    <div className={embedded ? 'mt-4' : 'page-container'}>
      {embedded ? (
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Didn&apos;t finish</h2>
            <p className="text-xs text-muted-foreground">Failed and cancelled downloads, with the reason and a retry button.</p>
          </div>
          <div className="flex items-center gap-2">
          {inTab.length > 0 && (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
            >
              <ListX className="w-3 h-3" /> {tab === 'all' ? 'Clear all' : `Clear ${TAB_LABELS[tab].toLowerCase()}`}
            </button>
          )}
          </div>
        </div>
      ) : (
      <>
      <div className="flex items-center justify-between page-header">
        <div>
          <h1 className="page-title">Library</h1>
          <p className="page-subtitle">Everything you&apos;ve downloaded, ready to play</p>
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
          {playerAvailable && <PlayFileMenu />}
          {inTab.length > 0 && (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
            >
              <ListX className="w-3 h-3" /> {tab === 'all' ? 'Clear all' : `Clear ${TAB_LABELS[tab].toLowerCase()}`}
            </button>
          )}
        </div>
      </div>

      </>
      )}

      {mode === 'media' && <LibraryActivity />}

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
                ref={searchRef}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search library…"
                aria-label="Search library"
                className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
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

        {/* One selected row too: it was the only way to move a download to the
            Recycle Bin, and a single row had no way at all. */}
        {selectedItems.length > 0 && (
          <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-lg bg-primary/8 border border-primary/20 text-xs animate-fade-in">
            <span className="text-foreground tabular-nums">{selectedItems.length} selected</span>
            <BulkButton icon={RotateCcw} label="Download again" onClick={() => selectedItems.forEach(requeue)} />
            <BulkButton icon={FolderOpen} label="Show in folder" onClick={revealSelected} />
            <BulkButton icon={ListX} label="Remove" onClick={removeSelected} />
            {trashTargets.length > 0 && (
              <BulkButton icon={Trash2} label={`Move to ${TRASH_NAME}`} onClick={() => setConfirmTrash(true)} />
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
            mode === 'attention' ? (
              <EmptyState
                icon={XCircle}
                title="Nothing needs attention"
                description="Downloads that fail or are cancelled show up here, with the reason and a retry button."
                className="py-8"
              />
            ) : (
              <EmptyState
                icon={Clock}
                title={tab === 'all' ? 'Nothing here yet' : `No ${TAB_LABELS[tab].toLowerCase()} yet`}
                description="Everything you download ends up here, ready to play."
                action={<EmptyActions play={playerAvailable} />}
              />
            )
          ) : (
            <VirtualList
              items={sorted}
              getKey={item => item.id}
              columns={columns}
              // A grid cell leads with a thumbnail and is much taller than a
              // row, so the estimate has to follow the layout — a fixed one
              // would leave the windowing maths wrong in whichever mode it
              // wasn't measured for.
              estimateSize={columns > 1 ? GRID_CARD_HEIGHT : preferences.listDensity === 'compact' ? 48 : 64}
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
        title={mode === 'attention'
          ? "Clear what didn't finish?"
          : tab === 'all' ? 'Clear the whole library?' : `Clear all ${TAB_LABELS[tab].toLowerCase()} items?`}
        description={`This removes ${inTab.length} entr${inTab.length === 1 ? 'y' : 'ies'} from ${mode === 'attention' ? 'this list' : 'the Library'}. Downloaded files stay on disk.`}
        confirmLabel={tab === 'all' ? 'Clear everything' : `Clear ${TAB_LABELS[tab].toLowerCase()}`}
        destructive
        onConfirm={clearCurrent}
      />

      <ConfirmDialog
        open={confirmTrash}
        onOpenChange={setConfirmTrash}
        title={`Move ${trashTargets.length} ${trashTargets.length === 1 ? 'download' : 'downloads'} to the ${TRASH_NAME}?`}
        description={[
          `The files go to the ${TRASH_NAME}, where you can put them back. Their library entries are removed too.`,
          trashFolders.length > 0
            ? `${trashFolders.length === 1 ? 'This folder goes' : 'These folders go'} with everything in ${trashFolders.length === 1 ? 'it' : 'them'}: ${trashFolders.map(n => `“${n}”`).join(', ')}.`
            : '',
          selectedItems.length > trashTargets.length
            ? `${selectedItems.length - trashTargets.length} selected ${selectedItems.length - trashTargets.length === 1 ? 'item has' : 'items have'} no file of its own on disk and will be left alone.`
            : '',
        ].join(' ').trim()}
        confirmLabel={`Move to ${TRASH_NAME}`}
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

  const [filesOpen, setFilesOpen] = useState(false);

  return (
    <div
      role="option"
      aria-selected={!!selected}
      onClick={handleClick}
      className={cn(
        'surface-row rounded-xl',
        density === 'compact' ? 'p-2' : 'p-3',
        // Every grid card is the same height: the grid is laid out in lanes,
        // and cards of different heights drifted out of line (2026-11-05).
        grid && 'flex flex-col overflow-hidden',
        selected && 'ring-1 ring-primary/60 bg-primary/5',
      )}
      style={grid ? { height: GRID_CARD_HEIGHT } : undefined}
    >
      {/* A grid cell leads with the picture, which is the useful handle for
          finished video; a row leads with the title. */}
      <div className={grid ? 'flex flex-col gap-2 h-full min-h-0' : 'flex items-start gap-3'}>
        {isFailed ? (
          <div className={cn(
            'rounded-lg bg-destructive/10 flex items-center justify-center shrink-0',
            grid ? 'w-full h-28' : 'w-8 h-8 mt-0.5',
          )}>
            <AlertTriangle className="w-4 h-4 text-destructive" aria-hidden="true" />
          </div>
        ) : (
          <Thumb
            src={item.metadata.thumbnail}
            className={grid ? 'w-full h-28 shrink-0' : 'w-[72px] h-10'}
            fallbackIcon={statusIcon(item.status)}
          />
        )}
        <div className={grid ? 'min-w-0' : 'flex-1 min-w-0'}>
          <div className="flex items-center gap-1.5 min-w-0">
            {statusIcon(item.status)}
            <h4 className="text-xs font-medium text-foreground truncate">{item.metadata.title}</h4>
          </div>
          <div className={cn(
            'flex items-center mt-0.5 text-xs text-muted-foreground tabular-nums whitespace-nowrap',
            // One line in a grid card, the date giving way first.
            grid ? 'gap-2 overflow-hidden [&>*]:shrink-0 [&>*:last-child]:shrink [&>*:last-child]:truncate' : 'gap-3 flex-wrap',
          )}>
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
            {grid && item.status === 'completed' && item.files && item.files.length > 0 && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setFilesOpen(true); }}
                className="underline decoration-dotted underline-offset-2 hover:text-foreground transition-colors"
                aria-label={`Show the ${item.files.length} files in ${item.metadata.title}`}
              >
                {item.files.length} file{item.files.length === 1 ? '' : 's'}
              </button>
            )}
            <span title={formatWhen(item.completedAt)}>{grid ? formatDay(item.completedAt) : formatWhen(item.completedAt)}</span>
          </div>
          {isFailed && item.error && <FailureNote error={item.error} onRetry={() => onRequeue(item)} />}
          {/* Torrent: expandable per-file list with per-file actions */}
          {!grid && item.status === 'completed' && item.files && item.files.length > 0 && (
            <div className="mt-1.5">
              <button
                type="button"
                onClick={() => onToggleExpanded(item.id)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                aria-expanded={expanded}
              >
                <ChevronRight className={cn('w-3 h-3 transition-transform', expanded && 'rotate-90')} />
                {item.files.length} {item.files.length === 1 ? 'file' : 'files'}
              </button>
              {expanded && <TorrentFiles item={item} playerAvailable={playerAvailable} />}
            </div>
          )}
        </div>
        <div className={cn('flex items-center gap-1 shrink-0', grid && 'mt-auto')}>
          {item.status === 'completed' && (() => {
            // Older torrent completions (flat multi-file torrents) were
            // recorded without a path — falling back to the destination
            // folder keeps the files reachable.
            const revealTarget = item.filePath
              ?? (isTorrent ? (item.outputFolder ?? item.settings.destination) : undefined);
            return (
              <>
                {/* In-app player: one file. A multi-file torrent's path is its
                    folder, which the player refuses; its files have their own
                    buttons in the expanded list. */}
                {playerAvailable && item.filePath && !(isTorrent && (item.files?.length ?? 0) > 1) && (
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
      {grid && filesOpen && (
        <Dialog open onOpenChange={setFilesOpen}>
          {/* Clicks inside a portal still bubble through React to the row,
              which would select it: stop them here. */}
          <DialogContent className="max-w-lg" onClick={(e) => e.stopPropagation()}>
            <DialogHeader>
              <DialogTitle className="truncate pr-6">{item.metadata.title}</DialogTitle>
              <DialogDescription>{(item.files ?? []).length} files</DialogDescription>
            </DialogHeader>
            <div className="max-h-[60vh] overflow-y-auto">
              <TorrentFiles item={item} playerAvailable={!!playerAvailable} />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
});
