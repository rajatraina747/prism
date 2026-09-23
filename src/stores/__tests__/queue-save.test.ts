import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createThrottledSaver, queueShape } from '../queue-save';
import type { DownloadItem } from '@/types/models';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('createThrottledSaver', () => {
  // Regression (REVIEW 2026-09-23 B-1): a debounce keyed on the queue never
  // fired while yt-dlp emitted every 250 ms, so queue.json stayed stale for
  // the whole download.
  it('saves within maxWait even when changes never stop', () => {
    const save = vi.fn();
    const saver = createThrottledSaver<number>(save, { wait: 300, maxWait: 2000 });
    for (let tick = 1; tick <= 8; tick++) {
      saver.schedule(tick);
      vi.advanceTimersByTime(250);
    }
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith(8);
  });

  it('saves once after a quiet spell, with the latest value', () => {
    const save = vi.fn();
    const saver = createThrottledSaver<number>(save, { wait: 300, maxWait: 2000 });
    saver.schedule(1);
    saver.schedule(2);
    vi.advanceTimersByTime(299);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(2);
  });

  it('flush saves at once and leaves nothing pending', () => {
    const save = vi.fn();
    const saver = createThrottledSaver<number>(save, { wait: 300, maxWait: 2000 });
    saver.schedule(1);
    saver.flush(2);
    expect(save).toHaveBeenCalledWith(2);
    vi.advanceTimersByTime(5000);
    expect(save).toHaveBeenCalledOnce();
  });

  it('flush with nothing pending does nothing', () => {
    const save = vi.fn();
    createThrottledSaver<number>(save, { wait: 300, maxWait: 2000 }).flush();
    expect(save).not.toHaveBeenCalled();
  });

  it('the maxWait clock restarts after each save', () => {
    const save = vi.fn();
    const saver = createThrottledSaver<number>(save, { wait: 300, maxWait: 2000 });
    for (let tick = 1; tick <= 16; tick++) {
      saver.schedule(tick);
      vi.advanceTimersByTime(250);
    }
    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe('queueShape', () => {
  const item = (id: string, status: DownloadItem['status'], progress = 0) =>
    ({ id, status, progress }) as DownloadItem;

  it('ignores progress but not status, membership or order', () => {
    const base = queueShape([item('a', 'downloading', 10), item('b', 'queued')]);
    expect(queueShape([item('a', 'downloading', 60), item('b', 'queued')])).toBe(base);
    expect(queueShape([item('a', 'completed', 100), item('b', 'queued')])).not.toBe(base);
    expect(queueShape([item('a', 'downloading', 10)])).not.toBe(base);
    expect(queueShape([item('b', 'queued'), item('a', 'downloading', 10)])).not.toBe(base);
  });
});
