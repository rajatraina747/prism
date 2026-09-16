import { describe, it, expect } from 'vitest';
import {
  emptyStats, recordCompletion, backfillFromHistory, engineOf, engineOfHistory,
  topBy, recentDays, hydrateStats, STATS_VERSION,
} from '../stats';
import type { DownloadItem, HistoryItem, DownloadKind } from '@/types/models';

function item(over: Partial<DownloadItem> = {}, url = 'https://www.youtube.com/watch?v=a'): DownloadItem {
  return {
    id: 'x',
    metadata: {
      title: 'A video', duration: 0, thumbnail: '',
      source: { url, domain: 'youtube.com', addedAt: '2026-09-16T00:00:00Z' },
      formats: [],
    },
    settings: { format: null, destination: '', filename: '', retryCount: 0, startImmediately: true },
    status: 'completed',
    progress: 100,
    speed: 0,
    eta: 0,
    downloadedBytes: 0,
    totalBytes: 1000,
    retryAttempt: 0,
    completedAt: '2026-09-16T10:00:00Z',
    ...over,
  };
}

function row(over: Partial<HistoryItem> = {}, url = 'https://www.youtube.com/watch?v=a'): HistoryItem {
  return {
    id: 'h',
    metadata: {
      title: 'A video', duration: 0, thumbnail: '',
      source: { url, domain: 'youtube.com', addedAt: '2026-09-01T00:00:00Z' },
      formats: [],
    },
    settings: { format: null, destination: '', filename: '', retryCount: 0, startImmediately: true },
    status: 'completed',
    completedAt: '2026-09-10T10:00:00Z',
    fileSize: 500,
    ...over,
  };
}

describe('engine attribution', () => {
  it('treats an item with no kind as yt-dlp, which is what absent has always meant', () => {
    expect(engineOf(item())).toBe('ytdlp');
    expect(engineOf(item({ kind: 'torrent' as DownloadKind }))).toBe('torrent');
    expect(engineOf(item({ kind: 'direct' as DownloadKind }))).toBe('direct');
  });

  it('infers a history row from its URL, since history keeps no kind', () => {
    expect(engineOfHistory(row({}, 'magnet:?xt=urn:btih:abc'))).toBe('torrent');
    expect(engineOfHistory(row({}, 'https://example.com/ubuntu.iso'))).toBe('direct');
    expect(engineOfHistory(row({}, 'https://www.youtube.com/watch?v=a'))).toBe('ytdlp');
  });
});

describe('recordCompletion', () => {
  it('counts bytes, engine, site, category and day', () => {
    const s = recordCompletion(emptyStats(), item({
      totalBytes: 2048,
      settings: { format: null, destination: '', filename: '', retryCount: 0, startImmediately: true, categoryName: 'Music' },
    }));
    expect(s.completed).toBe(1);
    expect(s.bytes).toBe(2048);
    expect(s.byEngine.ytdlp).toEqual({ items: 1, bytes: 2048 });
    expect(s.bySite['youtube.com']).toEqual({ items: 1, bytes: 2048 });
    expect(s.byCategory.Music).toEqual({ items: 1, bytes: 2048 });
    expect(s.byDay['2026-09-16']?.items ?? s.byDay[Object.keys(s.byDay)[0]].items).toBe(1);
  });

  it('counts a failure without letting its partial file inflate the totals', () => {
    const s = recordCompletion(emptyStats(), item({ downloadedBytes: 900, totalBytes: 0 }), 'failed');
    expect(s.failed).toBe(1);
    expect(s.completed).toBe(0);
    expect(s.bytes).toBe(0);
    expect(s.byEngine.ytdlp).toEqual({ items: 0, bytes: 0 });
  });

  it('keeps upload separate, and only once something has actually been uploaded', () => {
    const none = recordCompletion(emptyStats(), item());
    expect(none.uploadedBytes).toBe(0);
    expect(none.uploadedSince).toBeNull();

    const seeded = recordCompletion(emptyStats(), item({ kind: 'torrent' as DownloadKind, uploadedBytes: 4096 }));
    expect(seeded.uploadedBytes).toBe(4096);
    expect(seeded.uploadedSince).not.toBeNull();
  });

  it('never counts negative or nonsense sizes', () => {
    const s = recordCompletion(emptyStats(), item({ totalBytes: Number.NaN, downloadedBytes: -5 }));
    expect(s.bytes).toBe(0);
  });
});

describe('backfillFromHistory', () => {
  it('seeds from history and reaches back to the oldest row', () => {
    const s = backfillFromHistory(emptyStats(new Date('2026-09-16T00:00:00Z')), [
      row({ id: 'a', completedAt: '2026-09-10T10:00:00Z', fileSize: 100 }),
      row({ id: 'b', completedAt: '2026-09-11T10:00:00Z', fileSize: 200 }),
    ]);
    expect(s.completed).toBe(2);
    expect(s.bytes).toBe(300);
    expect(s.since).toBe('2026-09-10T10:00:00Z');
    expect(s.backfilledThrough).toBe('2026-09-11T10:00:00Z');
  });

  it('run twice, counts nothing twice', () => {
    const once = backfillFromHistory(emptyStats(), [row({ id: 'a', fileSize: 100 })]);
    const twice = backfillFromHistory(once, [row({ id: 'a', fileSize: 100 })]);
    expect(twice.completed).toBe(1);
    expect(twice.bytes).toBe(100);
  });

  it('picks up only rows newer than the last backfill', () => {
    const once = backfillFromHistory(emptyStats(), [row({ id: 'a', completedAt: '2026-09-10T10:00:00Z', fileSize: 100 })]);
    const again = backfillFromHistory(once, [
      row({ id: 'a', completedAt: '2026-09-10T10:00:00Z', fileSize: 100 }),
      row({ id: 'b', completedAt: '2026-09-12T10:00:00Z', fileSize: 250 }),
    ]);
    expect(again.completed).toBe(2);
    expect(again.bytes).toBe(350);
  });

  it('counts failed and canceled rows as outcomes but not as bytes', () => {
    const s = backfillFromHistory(emptyStats(), [
      row({ id: 'a', status: 'failed', fileSize: 999 }),
      row({ id: 'b', status: 'canceled', completedAt: '2026-09-11T10:00:00Z', fileSize: 999 }),
    ]);
    expect(s.failed).toBe(1);
    expect(s.canceled).toBe(1);
    expect(s.bytes).toBe(0);
  });
});

describe('selectors', () => {
  it('orders the bar lists by size', () => {
    const counts = { a: { items: 1, bytes: 10 }, b: { items: 5, bytes: 500 }, c: { items: 2, bytes: 50 } };
    expect(topBy(counts).map(x => x.key)).toEqual(['b', 'c', 'a']);
    expect(topBy(counts, 2)).toHaveLength(2);
  });

  it('zero-fills quiet days rather than closing the gap', () => {
    const now = new Date('2026-09-16T12:00:00Z');
    const s = recordCompletion(emptyStats(now), item({ completedAt: now.toISOString(), totalBytes: 10 }), 'completed', now);
    const days = recentDays(s, 7, now);
    expect(days).toHaveLength(7);
    expect(days[days.length - 1].items).toBe(1);
    expect(days.slice(0, -1).every(d => d.items === 0)).toBe(true);
  });
});

describe('hydrateStats', () => {
  it('fills in keys a older version never wrote', () => {
    const s = hydrateStats({ completed: 3, bytes: 99 });
    expect(s.completed).toBe(3);
    expect(s.bytes).toBe(99);
    expect(s.byEngine.torrent).toEqual({ items: 0, bytes: 0 });
    expect(s.version).toBe(STATS_VERSION);
  });

  it('treats nothing, or nonsense, as a fresh start', () => {
    expect(hydrateStats(null).completed).toBe(0);
    expect(hydrateStats('nope').completed).toBe(0);
    expect(hydrateStats([1, 2]).completed).toBe(0);
  });
});
