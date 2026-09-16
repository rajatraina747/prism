import type { DownloadItem, HistoryItem, DownloadKind } from '@/types/models';
import { isTorrentUrl, isDirectFileUrl, siteKey } from '@/services';

// What Prism has actually downloaded, kept as running counters.
//
// These can't be derived from the Library: history is capped at 2,000 rows, so
// anything older has already been forgotten. The counters are therefore their
// own record, updated as downloads finish and seeded once from whatever
// history exists at the time.

/** Which engine did the work. yt-dlp items carry no `kind` at all — absent has
 * always meant yt-dlp — so it gets a name of its own here rather than being
 * lumped in with direct downloads. */
export type StatsEngine = 'ytdlp' | 'torrent' | 'direct';

export interface Stats {
  /** Bumped when the shape changes, like settings. */
  version: number;
  /** When counting started, so the UI can say what the totals cover. */
  since: string;
  completed: number;
  failed: number;
  canceled: number;
  bytes: number;
  /** Torrents only, and only from downloads finished by this version onwards:
   * nothing in history records what was uploaded, so a backfill can't supply
   * it. Kept separate so it is never presented as a lifetime figure. */
  uploadedBytes: number;
  uploadedSince: string | null;
  byEngine: Record<StatsEngine, { items: number; bytes: number }>;
  /** Keyed by site (`siteKey`), by category name, and by calendar day. */
  bySite: Record<string, { items: number; bytes: number }>;
  byCategory: Record<string, { items: number; bytes: number }>;
  byDay: Record<string, { items: number; bytes: number }>;
  /** Ids already counted, so a backfill can run more than once without
   * double-counting. Only the backfilled ones need remembering. */
  backfilledThrough: string | null;
}

export const STATS_VERSION = 1;

const ENGINES: StatsEngine[] = ['ytdlp', 'torrent', 'direct'];

export function emptyStats(now = new Date()): Stats {
  return {
    version: STATS_VERSION,
    since: now.toISOString(),
    completed: 0,
    failed: 0,
    canceled: 0,
    bytes: 0,
    uploadedBytes: 0,
    uploadedSince: null,
    byEngine: { ytdlp: { items: 0, bytes: 0 }, torrent: { items: 0, bytes: 0 }, direct: { items: 0, bytes: 0 } },
    bySite: {},
    byCategory: {},
    byDay: {},
    backfilledThrough: null,
  };
}

/** The engine of a live item: `kind` is authoritative, and absent means yt-dlp. */
export function engineOf(item: { kind?: DownloadKind }): StatsEngine {
  if (item.kind === 'torrent') return 'torrent';
  if (item.kind === 'direct') return 'direct';
  return 'ytdlp';
}

/** The engine of a history row, which has no `kind` — the same inference the
 * Library makes from the source URL. Less certain than `engineOf`, which is
 * why it is only used for the backfill. */
export function engineOfHistory(item: HistoryItem): StatsEngine {
  const url = item.metadata.source.url;
  if (isTorrentUrl(url)) return 'torrent';
  if (isDirectFileUrl(url)) return 'direct';
  return 'ytdlp';
}

function day(iso: string): string {
  // Local calendar day: "what did I download on Tuesday" is a local question.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function bump(into: Record<string, { items: number; bytes: number }>, key: string, bytes: number) {
  const at = into[key] ?? { items: 0, bytes: 0 };
  into[key] = { items: at.items + 1, bytes: at.bytes + Math.max(0, bytes) };
}

interface Counted {
  engine: StatsEngine;
  status: 'completed' | 'failed' | 'canceled';
  bytes: number;
  when: string;
  site: string | null;
  category?: string;
}

function apply(stats: Stats, one: Counted): Stats {
  const next: Stats = {
    ...stats,
    byEngine: { ...stats.byEngine },
    bySite: { ...stats.bySite },
    byCategory: { ...stats.byCategory },
    byDay: { ...stats.byDay },
  };
  const bytes = Number.isFinite(one.bytes) ? Math.max(0, one.bytes) : 0;

  if (one.status === 'completed') next.completed += 1;
  else if (one.status === 'failed') next.failed += 1;
  else next.canceled += 1;

  // Only finished downloads contribute bytes: a failure's partial file is not
  // something the user got, and counting it would inflate every total.
  if (one.status !== 'completed') return next;

  next.bytes += bytes;
  const engine = next.byEngine[one.engine];
  next.byEngine[one.engine] = { items: engine.items + 1, bytes: engine.bytes + bytes };
  if (one.site) bump(next.bySite, one.site, bytes);
  if (one.category) bump(next.byCategory, one.category, bytes);
  bump(next.byDay, day(one.when), bytes);
  return next;
}

/** Record a download that just finished. */
export function recordCompletion(
  stats: Stats,
  item: DownloadItem,
  status: 'completed' | 'failed' | 'canceled' = 'completed',
  now = new Date(),
): Stats {
  const next = apply(stats, {
    engine: engineOf(item),
    status,
    bytes: item.totalBytes || item.downloadedBytes || 0,
    when: item.completedAt ?? now.toISOString(),
    site: siteKey(item.metadata.source.url),
    category: item.settings.categoryName,
  });

  // Upload is a torrent-only figure and only ever seen live.
  const uploaded = item.uploadedBytes ?? 0;
  if (status === 'completed' && uploaded > 0) {
    next.uploadedBytes += uploaded;
    next.uploadedSince = next.uploadedSince ?? stats.since;
  }
  return next;
}

/** Seed the counters from history, once. Rows are counted in completion order
 * and `backfilledThrough` records the newest one seen, so running it again —
 * after an update, say — adds only what is new instead of doubling everything. */
export function backfillFromHistory(stats: Stats, history: HistoryItem[]): Stats {
  const cutoff = stats.backfilledThrough;
  const ordered = [...history].sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  const fresh = cutoff ? ordered.filter(h => h.completedAt > cutoff) : ordered;
  if (fresh.length === 0) return stats;

  let next = stats;
  for (const row of fresh) {
    next = apply(next, {
      engine: engineOfHistory(row),
      status: row.status,
      bytes: row.fileSize || row.totalBytes || 0,
      when: row.completedAt,
      site: siteKey(row.metadata.source.url),
      category: row.settings.categoryName,
    });
  }
  // The oldest counted download is as far back as these numbers reach.
  const earliest = fresh[0].completedAt;
  return {
    ...next,
    since: earliest < next.since ? earliest : next.since,
    backfilledThrough: fresh[fresh.length - 1].completedAt,
  };
}

/** Biggest first, for the bar lists. */
export function topBy(
  counts: Record<string, { items: number; bytes: number }>,
  limit = 8,
): { key: string; items: number; bytes: number }[] {
  return Object.entries(counts)
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.bytes - a.bytes || b.items - a.items || a.key.localeCompare(b.key))
    .slice(0, limit);
}

/** The last `days` calendar days, oldest first, zero-filled so the chart has a
 * bar for a day nothing was downloaded rather than closing the gap. */
export function recentDays(stats: Stats, days = 30, now = new Date()): { day: string; items: number; bytes: number }[] {
  const out: { day: string; items: number; bytes: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = day(d.toISOString());
    const at = stats.byDay[key];
    out.push({ day: key, items: at?.items ?? 0, bytes: at?.bytes ?? 0 });
  }
  return out;
}

export function engineTotals(stats: Stats): { engine: StatsEngine; items: number; bytes: number }[] {
  return ENGINES.map(engine => ({ engine, ...stats.byEngine[engine] }));
}

/** Merge a stored object over the defaults, so counters written by an older
 * version pick up new keys instead of arriving undefined. */
export function hydrateStats(stored: unknown, now = new Date()): Stats {
  const base = emptyStats(now);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return base;
  const s = stored as Partial<Stats>;
  return {
    ...base,
    ...s,
    byEngine: { ...base.byEngine, ...(s.byEngine ?? {}) },
    bySite: { ...(s.bySite ?? {}) },
    byCategory: { ...(s.byCategory ?? {}) },
    byDay: { ...(s.byDay ?? {}) },
    version: STATS_VERSION,
  };
}
