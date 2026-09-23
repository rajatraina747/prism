import type { HistoryItem, LibrarySort } from '@/types/models';

/** The orderings offered, with their labels — the same shape as FILTERS and
 * SORTS in stores/transfers.ts, so the two pages stay recognisably alike. */
export const LIBRARY_SORTS: { id: LibrarySort; label: string }[] = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'title', label: 'Title' },
  { id: 'size', label: 'Largest first' },
];

// Pure ordering for the Library page, kept out of the component the same way
// the Transfers list model lives in stores/transfers.ts.

/** Completion time as a number, treating an unparseable stamp as 0.
 *
 * A comparator that returns NaN doesn't just misplace one row — it scrambles
 * the whole sort, so one corrupt record is not allowed to take the page with
 * it. */
function completedAtMs(item: HistoryItem): number {
  const ms = Date.parse(item.completedAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Order the Library.
 *
 * Every comparison falls back to newest-first when the primary key ties, so
 * the order is stable and predictable rather than depending on whatever order
 * history happened to be stored in. Returns a new array; the caller's list is
 * never sorted in place. */
export function sortHistory(items: HistoryItem[], sort: LibrarySort): HistoryItem[] {
  const newestFirst = (a: HistoryItem, b: HistoryItem) => completedAtMs(b) - completedAtMs(a);

  switch (sort) {
    case 'oldest':
      return [...items].sort((a, b) => completedAtMs(a) - completedAtMs(b));
    case 'title':
      return [...items].sort(
        (a, b) =>
          // Numeric so "Episode 2" sorts before "Episode 10", and base
          // sensitivity so case and accents don't split otherwise equal names.
          a.metadata.title.localeCompare(b.metadata.title, undefined, {
            sensitivity: 'base',
            numeric: true,
          }) || newestFirst(a, b),
      );
    case 'size':
      return [...items].sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0) || newestFirst(a, b));
    case 'newest':
    default:
      return [...items].sort(newestFirst);
  }
}

/** Columns a grid should use for a given width.
 *
 * Kept here rather than in the component so the breakpoints are testable and
 * in one place. The floor of 1 matters: at phone widths a "grid" is a list,
 * which is the honest answer rather than three unreadable columns. */
export function gridColumns(width: number): number {
  const TARGET = 240;
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.max(1, Math.min(6, Math.floor(width / TARGET)));
}

/** Strip trailing separators so `/a/b/` and `/a/b` compare equal. */
function trimSeparators(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

/** What "Move to Trash" may take for one Library row: its file, or the folder
 * a multi-file torrent owns. `folder` says which, so the confirmation can name
 * folders (their whole contents go with them).
 *
 * Never the folder the download was saved into. A single-file torrent's
 * `outputFolder` is the shared destination, and before 2.0.1 it could also be
 * recorded as its `filePath`; trashing that took every other download with it
 * (REVIEW 2026-09-23 B-3). Rust refuses such paths too; this keeps them out
 * of the request in the first place. */
export function trashTarget(item: HistoryItem): { path: string; folder: boolean } | undefined {
  const path = item.filePath ?? item.outputFolder;
  if (!path) return undefined;
  const candidate = trimSeparators(path);
  if (candidate === trimSeparators(item.settings.destination)) return undefined;
  const ownFolder = item.outputFolder !== undefined && candidate === trimSeparators(item.outputFolder);
  if (!ownFolder) return { path, folder: false };
  // An output folder is only this row's to trash when the torrent had many
  // files, which is when it gets a folder of its own.
  return (item.files?.length ?? 0) > 1 ? { path, folder: true } : undefined;
}

/** The last component of a path, for naming it in a dialog. */
export function baseName(p: string): string {
  const parts = trimSeparators(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
