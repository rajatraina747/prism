import { describe, it, expect } from 'vitest';
import { filterCounts, visibleTransfers, nextSelection, sortTransfers, categoriesInUse } from '../transfers';
import type { DownloadItem, DownloadStatus } from '@/types/models';

function item(id: string, status: DownloadStatus, extra: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id,
    metadata: { title: `Item ${id}`, duration: 0, thumbnail: '', source: { url: `https://x/${id}`, domain: 'x', addedAt: '' }, formats: [] },
    settings: { format: null, destination: '', filename: '', retryCount: 0, startImmediately: true },
    status,
    progress: 0,
    speed: 0,
    eta: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    retryAttempt: 0,
    ...extra,
  };
}

describe('transfers helpers', () => {
  const items = [
    item('a', 'downloading', { speed: 500, progress: 10, totalBytes: 100, eta: 50 }),
    item('b', 'seeding', { ratio: 1.4, totalBytes: 300 }),
    item('c', 'paused', { progress: 40, totalBytes: 200, eta: 0 }),
    item('d', 'failed'),
    item('e', 'completed'),
    item('f', 'queued', { metadata: { title: 'Aardvark', duration: 0, thumbnail: '', source: { url: 'u', domain: 'x', addedAt: '' }, formats: [] } }),
  ];

  it('counts per filter, excluding archived items', () => {
    const counts = filterCounts(items.filter(i => i.status !== 'completed'));
    expect(counts).toEqual({ all: 5, downloading: 1, seeding: 1, paused: 1, queued: 1, errored: 1 });
  });

  it('filters, searches and never shows completed/canceled', () => {
    expect(visibleTransfers(items, 'all', 'added', '').map(i => i.id)).toEqual(['a', 'b', 'c', 'd', 'f']);
    expect(visibleTransfers(items, 'errored', 'added', '').map(i => i.id)).toEqual(['d']);
    expect(visibleTransfers(items, 'all', 'added', 'aard').map(i => i.id)).toEqual(['f']);
  });

  it('filters by category, and lists only the categories in use', () => {
    const filed = (id: string, status: DownloadStatus, categoryId?: string, categoryName?: string) =>
      item(id, status, {
        settings: {
          format: null, destination: '', filename: '', retryCount: 0, startImmediately: true,
          ...(categoryId ? { categoryId, categoryName } : {}),
        },
      });
    const list = [
      filed('a', 'downloading', 'music', 'Music'),
      filed('b', 'queued', 'music', 'Music'),
      filed('c', 'paused', 'iso', 'ISOs'),
      filed('d', 'queued'),
    ];
    expect(categoriesInUse(list)).toEqual([{ id: 'music', name: 'Music' }, { id: 'iso', name: 'ISOs' }]);
    expect(visibleTransfers(list, 'all', 'added', '', 'music').map(i => i.id)).toEqual(['a', 'b']);
    expect(visibleTransfers(list, 'queued', 'added', '', 'music').map(i => i.id)).toEqual(['b']);
    // No category chosen is "all of them", not "the ones with no category".
    expect(visibleTransfers(list, 'all', 'added', '', null).map(i => i.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sorts by each key and keeps queue order under "added"', () => {
    const live = items.filter(i => i.status !== 'completed');
    expect(sortTransfers(live, 'added').map(i => i.id)).toEqual(['a', 'b', 'c', 'd', 'f']);
    expect(sortTransfers(live, 'name')[0].id).toBe('f'); // "Aardvark"
    expect(sortTransfers(live, 'progress')[0].id).toBe('c');
    expect(sortTransfers(live, 'speed')[0].id).toBe('a');
    expect(sortTransfers(live, 'size')[0].id).toBe('b');
    expect(sortTransfers(live, 'ratio')[0].id).toBe('b');
    // Unknown ETA sorts last.
    const byEta = sortTransfers(live, 'eta').map(i => i.id);
    expect(byEta[0]).toBe('a');
    expect(byEta.indexOf('c')).toBeGreaterThan(0);
  });

  it('selection: click, meta-toggle, shift-range', () => {
    const ids = ['a', 'b', 'c', 'd'];
    let s = nextSelection(new Set(), null, ids, 'b', { shift: false, meta: false });
    expect([...s.selection]).toEqual(['b']);
    s = nextSelection(s.selection, s.anchor, ids, 'd', { shift: false, meta: true });
    expect([...s.selection].sort()).toEqual(['b', 'd']);
    s = nextSelection(s.selection, s.anchor, ids, 'd', { shift: false, meta: true });
    expect([...s.selection]).toEqual(['b']);
    s = nextSelection(new Set(['a']), 'a', ids, 'c', { shift: true, meta: false });
    expect([...s.selection]).toEqual(['a', 'b', 'c']);
    expect(s.anchor).toBe('a');
  });
});
