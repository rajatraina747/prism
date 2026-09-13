import type { DownloadItem, TransfersFilter, TransfersSort } from '@/types/models';

// Pure helpers for the Transfers page: status filtering, sorting and the
// counts shown on the filter tabs. Kept out of the component so they're
// unit-testable and reusable (context menu, shortcuts, bulk bar).

export const FILTERS: { id: TransfersFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'downloading', label: 'Downloading' },
  { id: 'seeding', label: 'Seeding' },
  { id: 'paused', label: 'Paused' },
  { id: 'queued', label: 'Queued' },
  { id: 'errored', label: 'Errored' },
];

export const SORTS: { id: TransfersSort; label: string }[] = [
  { id: 'added', label: 'Added' },
  { id: 'name', label: 'Name' },
  { id: 'progress', label: 'Progress' },
  { id: 'speed', label: 'Down speed' },
  { id: 'eta', label: 'ETA' },
  { id: 'size', label: 'Size' },
  { id: 'ratio', label: 'Ratio' },
];

/** Items the Transfers page shows at all: everything not yet archived. */
export function isTransfer(item: DownloadItem): boolean {
  return item.status !== 'completed' && item.status !== 'canceled';
}

export function matchesFilter(item: DownloadItem, filter: TransfersFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'downloading': return item.status === 'downloading';
    case 'seeding': return item.status === 'seeding';
    case 'paused': return item.status === 'paused';
    case 'queued': return item.status === 'queued';
    case 'errored': return item.status === 'failed';
  }
}

export function filterCounts(items: DownloadItem[]): Record<TransfersFilter, number> {
  const counts = { all: 0, downloading: 0, seeding: 0, paused: 0, queued: 0, errored: 0 };
  for (const i of items) {
    for (const f of FILTERS) if (matchesFilter(i, f.id)) counts[f.id] += 1;
  }
  return counts;
}

/** Sort. 'added' preserves queue order (the user's priority order), so
 * drag-reorder only makes sense under it; the page disables reorder otherwise. */
export function sortTransfers(items: DownloadItem[], sort: TransfersSort): DownloadItem[] {
  if (sort === 'added') return items;
  const eta = (i: DownloadItem) => (i.eta > 0 ? i.eta : Number.POSITIVE_INFINITY);
  const cmp: Record<Exclude<TransfersSort, 'added'>, (a: DownloadItem, b: DownloadItem) => number> = {
    name: (a, b) => a.metadata.title.localeCompare(b.metadata.title, undefined, { sensitivity: 'base' }),
    progress: (a, b) => b.progress - a.progress,
    speed: (a, b) => (b.speed || 0) - (a.speed || 0),
    eta: (a, b) => eta(a) - eta(b),
    size: (a, b) => (b.totalBytes || 0) - (a.totalBytes || 0),
    ratio: (a, b) => (b.ratio ?? 0) - (a.ratio ?? 0),
  };
  return [...items].sort(cmp[sort]);
}

export function visibleTransfers(
  items: DownloadItem[],
  filter: TransfersFilter,
  sort: TransfersSort,
  search: string,
): DownloadItem[] {
  const q = search.trim().toLowerCase();
  const filtered = items.filter(
    i => isTransfer(i) && matchesFilter(i, filter) && (!q || i.metadata.title.toLowerCase().includes(q)),
  );
  return sortTransfers(filtered, sort);
}

/** Row selection with click / shift-click (range) / meta-click (toggle). */
export function nextSelection(
  current: Set<string>,
  anchor: string | null,
  orderedIds: string[],
  clickedId: string,
  mods: { shift: boolean; meta: boolean },
): { selection: Set<string>; anchor: string } {
  if (mods.shift && anchor && orderedIds.includes(anchor)) {
    const a = orderedIds.indexOf(anchor);
    const b = orderedIds.indexOf(clickedId);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const range = orderedIds.slice(lo, hi + 1);
    return { selection: new Set(mods.meta ? [...current, ...range] : range), anchor };
  }
  if (mods.meta) {
    const next = new Set(current);
    if (next.has(clickedId)) next.delete(clickedId);
    else next.add(clickedId);
    return { selection: next, anchor: clickedId };
  }
  return { selection: new Set([clickedId]), anchor: clickedId };
}
