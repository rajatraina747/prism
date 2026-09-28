import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockPrismService } from '../mock';
import type { ArchivedEntry, QueuePatch } from '@/stores/remote-queue';
import { buildItem, linkMetadata } from '@/stores/build-item';

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const item = (id = 'a') => ({
  ...buildItem({ metadata: linkMetadata('https://example.com/v', 'A video', 'example.com'), settings: { format: null, destination: '~/dl', filename: 'x' } }),
  id,
  totalBytes: 1_000_000,
});

// REVIEW 2026-09-28 A-1: the web demo's queue behind Rust's interface.
describe('MockQueue', () => {
  it('starts what is added, reports patches, and archives what finishes', async () => {
    const service = new MockPrismService();
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // no simulated failure
    const patches: QueuePatch[] = [];
    const archived: ArchivedEntry[] = [];
    service.queue.subscribe({ changed: p => patches.push(p), archived: e => archived.push(...e), notice: () => {}, whenDone: () => {} });
    await service.queue.add(item());
    expect(patches.at(-1)?.items.some(i => i.id === 'a' && i.status === 'downloading')).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(archived.map(e => e.history.status)).toEqual(['completed']);
    expect((await service.queue.snapshot()).items).toHaveLength(0);
  });

  it('pauses and resumes', async () => {
    const service = new MockPrismService();
    service.queue.subscribe({ changed: () => {}, archived: () => {}, notice: () => {}, whenDone: () => {} });
    await service.queue.add(item('b'));
    await service.queue.pause('b');
    expect((await service.queue.snapshot()).items[0].status).toBe('paused');
    await service.queue.resume('b');
    expect((await service.queue.snapshot()).items[0].status).toBe('downloading');
  });
});
