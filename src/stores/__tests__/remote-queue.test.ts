import { describe, it, expect } from 'vitest';
import { applyQueuePatch } from '@/stores/remote-queue';
import type { DownloadItem } from '@/types/models';

const item = (id: string, status: DownloadItem['status'] = 'queued', progress = 0) =>
  ({ id, status, progress } as unknown as DownloadItem);

describe('applyQueuePatch', () => {
  it('replaces changed items, drops removed ones and appends new ones', () => {
    const q = [item('a'), item('b'), item('c')];
    const next = applyQueuePatch(q, { items: [item('b', 'downloading', 40), item('d')], removed: ['a'] });
    expect(next.map(i => [i.id, i.status, i.progress])).toEqual([['b', 'downloading', 40], ['c', 'queued', 0], ['d', 'queued', 0]]);
  });

  it('follows a new order', () => {
    const next = applyQueuePatch([item('a'), item('b'), item('c')], { items: [], removed: [], order: ['c', 'a', 'b'] });
    expect(next.map(i => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('an item removed and changed in one patch stays removed', () => {
    expect(applyQueuePatch([item('a')], { items: [item('a', 'completed')], removed: ['a'] })).toEqual([]);
  });

  it('keeps the same objects for items that did not change', () => {
    const b = item('b');
    const next = applyQueuePatch([item('a'), b], { items: [item('a', 'paused')], removed: [] });
    expect(next[1]).toBe(b);
  });
});
