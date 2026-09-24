import { describe, it, expect } from 'vitest';
import { applyFinished } from '../finished';
import type { DownloadItem } from '@/types/models';

const item = (id: string, status: DownloadItem['status']) => ({ id, status, progress: 40, speed: 5, eta: 9 } as unknown as DownloadItem);

// Regression (REVIEW 2026-09-23 B-1, twice): a finished download whose save
// never reached queue.json was still queued on relaunch and downloaded again.
describe('applyFinished', () => {
  it('marks what Rust saw finish as completed, with its file', () => {
    const [done] = applyFinished([item('a', 'queued')], [{ id: 'a', completedAt: '2026-09-24T00:00:00Z', filePath: '/dl/a.mp4', fileSize: 10 }]);
    expect(done).toMatchObject({ status: 'completed', progress: 100, speed: 0, eta: 0, filePath: '/dl/a.mp4', totalBytes: 10, completedAt: '2026-09-24T00:00:00Z' });
  });

  it('leaves everything else alone, and returns the same queue when nothing applies', () => {
    const queue = [item('b', 'queued'), item('c', 'failed')];
    expect(applyFinished(queue, [{ id: 'c', completedAt: 'x' }, { id: 'gone', completedAt: 'x' }])).toBe(queue);
    expect(applyFinished(queue, [])).toBe(queue);
  });

  it('drops an item the Library already has instead of archiving it twice', () => {
    const next = applyFinished([item('a', 'queued'), item('b', 'queued')], [{ id: 'a', completedAt: 'x' }], new Set(['a']));
    expect(next.map(i => i.id)).toEqual(['b']);
  });
});
