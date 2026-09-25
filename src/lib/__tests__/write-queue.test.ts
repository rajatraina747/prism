import { describe, it, expect } from 'vitest';
import { createWriteQueue } from '../write-queue';

// Regression (REVIEW 2026-09-26 L2): saves of one file never overlap, and
// the last content saved is the one that ends up on disk.
describe('createWriteQueue', () => {
  it('never runs two writes of one file at once, and ends on the newest content', async () => {
    const disk = new Map<string, string>();
    const inFlight = new Set<string>();
    let overlapped = false;
    const writes: string[] = [];
    const save = createWriteQueue(async (file, text) => {
      if (inFlight.has(file)) overlapped = true;
      inFlight.add(file);
      await new Promise(r => setTimeout(r, 5));
      disk.set(file, text);
      writes.push(text);
      inFlight.delete(file);
    });

    await Promise.all([save('settings.json', 'a'), save('settings.json', 'b'), save('settings.json', 'c')]);
    expect(overlapped).toBe(false);
    expect(disk.get('settings.json')).toBe('c');
    // 'b' was superseded before its turn, so it was never written.
    expect(writes).toEqual(['a', 'c']);
  });

  it('lets different files write side by side', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const save = createWriteQueue(async (file) => {
      started.push(file);
      await gate;
    });
    const both = Promise.all([save('queue.json', 'q'), save('history.json', 'h')]);
    await Promise.resolve();
    expect(started).toEqual(['queue.json', 'history.json']);
    release();
    await both;
  });

  it('keeps going after a failed write', async () => {
    const written: string[] = [];
    let first = true;
    const save = createWriteQueue(async (_file, text) => {
      if (first) { first = false; throw new Error('disk full'); }
      written.push(text);
    });
    await save('stats.json', 'x');
    await save('stats.json', 'y');
    expect(written).toEqual(['y']);
  });
});
