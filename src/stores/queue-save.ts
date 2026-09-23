import type { DownloadItem } from '@/types/models';

// When the queue reaches disk. It used to be a 300 ms debounce keyed on the
// queue, but progress events arrive every 250 ms, so while anything downloaded
// the timer never fired and queue.json stayed at the last idle snapshot. On
// relaunch, everything that finished since then downloaded again (REVIEW
// 2026-09-23 B-1).
//
// A flush on quit can't fix this. ⌘Q on macOS goes straight to
// `applicationWillTerminate`, which Tauri reports only as `RunEvent::Exit`, too
// late to wait on the webview. So the changes that matter on relaunch are
// saved as they happen, and progress, which is refilled by the next run, is
// throttled.

/** What the next launch acts on: which items exist, in what order, in what
 * state. When this changes the queue is saved at once; progress alone waits. */
export function queueShape(queue: DownloadItem[]): string {
  return queue.map(i => `${i.id}:${i.status}`).join('|');
}

export interface ThrottledSaver<T> {
  /** Save `value` after `wait` of quiet, and never more than `maxWait` after
   * the first unsaved change, however busy the queue stays. */
  schedule(value: T): void;
  /** Save now: `value` if given, else whatever is pending. */
  flush(value?: T): void;
  /** Drop anything pending without saving it. */
  cancel(): void;
}

export function createThrottledSaver<T>(
  save: (value: T) => void,
  { wait, maxWait }: { wait: number; maxWait: number },
): ThrottledSaver<T> {
  let pending: { value: T } | null = null;
  let firstPendingAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const fire = () => {
    clear();
    if (!pending) return;
    const { value } = pending;
    pending = null;
    firstPendingAt = null;
    save(value);
  };

  return {
    schedule(value) {
      const now = Date.now();
      pending = { value };
      firstPendingAt ??= now;
      clear();
      timer = setTimeout(fire, Math.min(wait, Math.max(0, firstPendingAt + maxWait - now)));
    },
    flush(value) {
      if (value !== undefined) pending = { value };
      fire();
    },
    cancel() {
      clear();
      pending = null;
      firstPendingAt = null;
    },
  };
}
