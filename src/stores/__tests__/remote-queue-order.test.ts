import { describe, it, expect } from 'vitest';
import { applyQueuePatch, patchesAfter, type QueuePatch } from '../remote-queue';
import type { DownloadItem } from '@/types/models';

const item = (id: string, status: DownloadItem['status'] = 'queued') => ({ id, status } as DownloadItem);

// Regression (REVIEW 2026-09-28 C-9): the snapshot's answer could land after
// a patch Rust sent later, and replaced the queue with the older picture.
describe('patchesAfter', () => {
  it('keeps only the early patches the snapshot does not already reflect', () => {
    const early: QueuePatch[] = [
      { seq: 4, items: [item('a', 'downloading')], removed: [] },
      { seq: 5, items: [], removed: ['b'] },
      { seq: 6, items: [item('c')], removed: [] },
    ];
    const later = patchesAfter(early, 4);
    expect(later.map(p => p.seq)).toEqual([5, 6]);
    // Snapshot taken at seq 4 still listed b; the removal after it must stand.
    const snapshot = [item('a', 'downloading'), item('b')];
    const queue = later.reduce(applyQueuePatch, snapshot);
    expect(queue.map(i => i.id)).toEqual(['a', 'c']);
  });
});

// REVIEW 2026-09-28 P-4: a patch leaves out an unchanged file list.
describe('applyQueuePatch and file lists', () => {
  it('keeps the file list and piece map a patch left out', () => {
    const files = [{ name: 'a.mkv', size: 1, progress: 50, selected: true }];
    const before = [{ ...item('t', 'downloading'), files, pieces: [1, 0] } as unknown as DownloadItem];
    const after = applyQueuePatch(before, { items: [{ ...item('t', 'downloading'), speed: 9 } as DownloadItem], removed: [] });
    expect(after[0].files).toBe(files);
    expect(after[0].pieces).toEqual([1, 0]);
    expect(after[0].speed).toBe(9);
  });
});
