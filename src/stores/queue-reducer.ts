import type { DownloadItem, DownloadError } from '@/types/models';

// The queue state machine. All transitions live here so their guards are
// explicit and unit-testable; AppProvider only performs side effects
// (spawning/killing downloads) and dispatches.
//
// Guard principle: user intent wins races. A completion/failure/retry event
// from the backend only applies while the item is still 'downloading' — if
// the user paused, canceled, or removed the item while the event was in
// flight, the backend event is ignored.

export type QueueAction =
  | { type: 'add'; item: DownloadItem }
  | { type: 'markStarted'; id: string; startedAt: string }
  | {
      type: 'progress';
      id: string;
      data: Partial<
        Pick<
          DownloadItem,
          'progress' | 'speed' | 'eta' | 'downloadedBytes' | 'totalBytes' | 'peers' | 'seeds' | 'uploadSpeed' | 'ratio'
        >
      >;
      // Torrent-only: the download finished and the item is now uploading.
      // Drives the 'downloading' → 'seeding' transition. HTTP items never set it.
      seeding?: boolean;
    }
  | { type: 'completed'; id: string; completedAt: string; filePath?: string; fileSize?: number }
  | { type: 'failed'; id: string; error: DownloadError }
  | { type: 'requeueForRetry'; id: string }
  | { type: 'pause'; id: string }
  | { type: 'resume'; id: string }
  | { type: 'cancel'; id: string }
  | { type: 'retry'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'removeMany'; ids: string[] }
  | { type: 'clearCompleted' }
  | { type: 'startAll' }
  | { type: 'pauseAll' }
  | { type: 'reorder'; from: number; to: number };

const IDLE_COUNTERS = { progress: 0, downloadedBytes: 0, speed: 0, eta: 0 } as const;

function update(
  queue: DownloadItem[],
  id: string,
  fn: (item: DownloadItem) => DownloadItem,
): DownloadItem[] {
  return queue.map(i => (i.id === id ? fn(i) : i));
}

export function queueReducer(queue: DownloadItem[], action: QueueAction): DownloadItem[] {
  switch (action.type) {
    case 'add':
      return [...queue, action.item];

    case 'markStarted':
      return update(queue, action.id, i =>
        i.status === 'queued'
          ? { ...i, status: 'downloading', startedAt: action.startedAt }
          : i,
      );

    case 'progress':
      return update(queue, action.id, i => {
        // A torrent that hit 100% moves to 'seeding'; from there we keep
        // applying swarm-stat updates but never fall back to 'downloading'.
        if (i.status === 'downloading') {
          return { ...i, ...action.data, status: action.seeding ? 'seeding' : 'downloading' };
        }
        if (i.status === 'seeding') {
          return { ...i, ...action.data };
        }
        return i;
      });

    case 'completed':
      // Torrents reach this from 'seeding' (once the seed policy is satisfied
      // or the user stops), HTTP items from 'downloading'.
      return update(queue, action.id, i =>
        i.status === 'downloading' || i.status === 'seeding'
          ? {
              ...i,
              status: 'completed',
              progress: 100,
              speed: 0,
              eta: 0,
              uploadSpeed: 0,
              completedAt: action.completedAt,
              filePath: action.filePath,
              totalBytes: action.fileSize ?? i.totalBytes,
            }
          : i,
      );

    case 'failed':
      // 'queued' is included to cover start-invoke failures that land before
      // markStarted is processed; pause/cancel still win.
      return update(queue, action.id, i =>
        i.status === 'downloading' || i.status === 'queued'
          ? { ...i, status: 'failed', speed: 0, eta: 0, error: action.error }
          : i,
      );

    case 'requeueForRetry':
      return update(queue, action.id, i =>
        i.status === 'downloading'
          ? { ...i, status: 'queued', retryAttempt: i.retryAttempt + 1, ...IDLE_COUNTERS, error: undefined }
          : i,
      );

    case 'pause':
      return update(queue, action.id, i =>
        i.status === 'queued' || i.status === 'downloading' || i.status === 'seeding'
          ? { ...i, status: 'paused', speed: 0, eta: 0, uploadSpeed: 0 }
          : i,
      );

    case 'resume':
      return update(queue, action.id, i =>
        i.status === 'paused' ? { ...i, status: 'queued' } : i,
      );

    case 'cancel':
      return update(queue, action.id, i =>
        i.status === 'completed' ? i : { ...i, status: 'canceled', speed: 0, eta: 0 },
      );

    case 'retry':
      return update(queue, action.id, i => ({
        ...i,
        status: 'queued',
        retryAttempt: i.retryAttempt + 1,
        ...IDLE_COUNTERS,
        error: undefined,
      }));

    case 'remove':
      return queue.filter(i => i.id !== action.id);

    case 'removeMany': {
      const ids = new Set(action.ids);
      return queue.filter(i => !ids.has(i.id));
    }

    case 'clearCompleted':
      return queue.filter(i => i.status !== 'completed');

    case 'startAll':
      return queue.map(i => (i.status === 'paused' ? { ...i, status: 'queued' as const } : i));

    case 'pauseAll':
      return queue.map(i =>
        i.status === 'downloading' || i.status === 'seeding'
          ? { ...i, status: 'paused' as const, speed: 0, eta: 0, uploadSpeed: 0 }
          : i,
      );

    case 'reorder': {
      const next = [...queue];
      const [moved] = next.splice(action.from, 1);
      if (moved === undefined) return queue;
      next.splice(action.to, 0, moved);
      return next;
    }
  }
}
