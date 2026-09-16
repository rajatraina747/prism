import { describe, it, expect } from 'vitest';
import {
  isBusy, isQueueBusy, evaluateWhenDone, whenDoneLabel,
  IDLE_WHEN_DONE, type WhenDoneAction,
} from '../completion';
import type { DownloadItem, DownloadStatus } from '@/types/models';

function item(status: DownloadStatus): DownloadItem {
  return {
    id: status,
    metadata: {
      title: status, duration: 0, thumbnail: '',
      source: { url: 'https://example.com/a', domain: 'example.com', addedAt: '' },
      formats: [],
    },
    settings: { format: null, destination: '', filename: '', retryCount: 0, startImmediately: true },
    status,
    progress: 0,
    speed: 0,
    eta: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    retryAttempt: 0,
  };
}

const prefs = (over: Partial<{ whenDoneAction: WhenDoneAction; whenDoneIgnoresSeeding: boolean }> = {}) => ({
  whenDoneAction: 'sleep' as WhenDoneAction,
  whenDoneIgnoresSeeding: false,
  ...over,
});

describe('isBusy', () => {
  it('counts everything that still needs Prism awake', () => {
    for (const s of ['queued', 'parsing', 'ready', 'downloading'] as DownloadStatus[]) {
      expect(isBusy(item(s), false)).toBe(true);
    }
  });

  it('does not count a paused download, which will never finish on its own', () => {
    expect(isBusy(item('paused'), false)).toBe(false);
  });

  it('counts seeding as work unless that is explicitly waived', () => {
    expect(isBusy(item('seeding'), false)).toBe(true);
    expect(isBusy(item('seeding'), true)).toBe(false);
  });

  it('does not count anything already finished', () => {
    for (const s of ['completed', 'failed', 'canceled'] as DownloadStatus[]) {
      expect(isBusy(item(s), false)).toBe(false);
    }
  });
});

describe('evaluateWhenDone', () => {
  it('never fires from a standing start — the trap this rule exists to avoid', () => {
    // Someone turns on "sleep when done" with nothing queued.
    const { state, start } = evaluateWhenDone(IDLE_WHEN_DONE, [], prefs());
    expect(start).toBe(false);
    expect(state.armed).toBe(false);
  });

  it('fires once work has finished, and only once', () => {
    let s = IDLE_WHEN_DONE;
    ({ state: s } = evaluateWhenDone(s, [item('downloading')], prefs()));
    expect(s.wasBusy).toBe(true);

    const done = evaluateWhenDone(s, [item('completed')], prefs());
    expect(done.start).toBe(true);

    // A re-render with the same queue must not start a second countdown.
    const again = evaluateWhenDone(done.state, [item('completed')], prefs());
    expect(again.start).toBe(false);
  });

  it('arms again when new work arrives after a quiet period', () => {
    let s = IDLE_WHEN_DONE;
    ({ state: s } = evaluateWhenDone(s, [item('downloading')], prefs()));
    const first = evaluateWhenDone(s, [item('completed')], prefs());
    expect(first.start).toBe(true);

    // Something new starts, then finishes: that deserves its own countdown.
    const busyAgain = evaluateWhenDone(first.state, [item('downloading')], prefs());
    expect(busyAgain.start).toBe(false);
    const secondDone = evaluateWhenDone(busyAgain.state, [item('completed')], prefs());
    expect(secondDone.start).toBe(true);
  });

  it('waits for seeding to stop, unless told not to', () => {
    let s = IDLE_WHEN_DONE;
    ({ state: s } = evaluateWhenDone(s, [item('downloading')], prefs()));

    // Still uploading: not finished.
    const seeding = evaluateWhenDone(s, [item('seeding')], prefs());
    expect(seeding.start).toBe(false);

    // The same queue, for someone who said seeding shouldn't hold it up.
    const waived = evaluateWhenDone(s, [item('seeding')], prefs({ whenDoneIgnoresSeeding: true }));
    expect(waived.start).toBe(true);
  });

  it('does nothing at all when the action is off, and forgets what it saw', () => {
    let s = IDLE_WHEN_DONE;
    ({ state: s } = evaluateWhenDone(s, [item('downloading')], prefs()));
    const off = evaluateWhenDone(s, [item('completed')], prefs({ whenDoneAction: 'nothing' }));
    expect(off.start).toBe(false);
    expect(off.state).toEqual(IDLE_WHEN_DONE);

    // Turning it back on now must still wait for fresh work, not fire at once.
    const backOn = evaluateWhenDone(off.state, [item('completed')], prefs());
    expect(backOn.start).toBe(false);
  });

  it('treats a queue of paused downloads as finished', () => {
    let s = IDLE_WHEN_DONE;
    ({ state: s } = evaluateWhenDone(s, [item('downloading')], prefs()));
    expect(evaluateWhenDone(s, [item('paused')], prefs()).start).toBe(true);
  });
});

describe('isQueueBusy', () => {
  it('is busy while any one item is', () => {
    expect(isQueueBusy([item('completed'), item('downloading')])).toBe(true);
    expect(isQueueBusy([item('completed'), item('failed')])).toBe(false);
    expect(isQueueBusy([])).toBe(false);
  });
});

describe('whenDoneLabel', () => {
  it('names the action for the countdown toast', () => {
    expect(whenDoneLabel('sleep')).toBe('Sleeping');
    expect(whenDoneLabel('shutdown')).toBe('Shutting down');
    expect(whenDoneLabel('quit')).toBe('Quitting Prism');
    expect(whenDoneLabel('nothing')).toBe('');
  });
});
