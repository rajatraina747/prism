import type { DownloadItem, DownloadError, DownloadCategory, PostCompletionAction } from '@/types/models';
import { applyCategory } from '@/stores/categories';
import { normalizeSha256 } from '@/stores/checksum';

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
          'progress' | 'speed' | 'eta' | 'downloadedBytes' | 'totalBytes' | 'stage' | 'peers' | 'peersSeen' | 'peersConnecting' | 'uploadSpeed' | 'ratio' | 'files' | 'uploadedBytes' | 'peerlessSecs' | 'pieces'
        >
      >;
      // Torrent-only: the download finished and the item is now uploading.
      // Drives the 'downloading' → 'seeding' transition. HTTP items never set it.
      seeding?: boolean;
    }
  | { type: 'completed'; id: string; completedAt: string; filePath?: string; fileSize?: number; actualHeight?: number; outputFolder?: string }
  | { type: 'failed'; id: string; error: DownloadError }
  | { type: 'requeueForRetry'; id: string }
  | { type: 'pause'; id: string }
  | { type: 'resume'; id: string }
  | { type: 'cancel'; id: string }
  | { type: 'retry'; id: string }
  | { type: 'setSelectedFiles'; id: string; files: number[] }
  | { type: 'setCategory'; id: string; category: DownloadCategory | null }
  | { type: 'setLabels'; id: string; labelIds: string[] }
  | { type: 'setChecksum'; id: string; sha256: string | null }
  | { type: 'setWhenComplete'; id: string; action: PostCompletionAction | null }
  | { type: 'remove'; id: string }
  | { type: 'removeMany'; ids: string[] }
  | { type: 'clearCompleted' }
  | { type: 'startAll' }
  | { type: 'pauseAll' }
  | { type: 'reorder'; from: number; to: number };

// Reset on retry/requeue. Deliberately keeps totalBytes (a retried torrent
// must not fall back to a placeholder size), uploadedBytes and ratio (lifetime
// upload is history, not a counter), files and pieces (still the same torrent).
const IDLE_COUNTERS = { progress: 0, downloadedBytes: 0, speed: 0, eta: 0, stage: undefined, peerlessSecs: 0 } as const;

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
      return [...queue, { ...action.item, addedAt: action.item.addedAt ?? new Date().toISOString() }];

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
              actualHeight: action.actualHeight,
              outputFolder: action.outputFolder ?? i.outputFolder,
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

    case 'setSelectedFiles':
      // Persisted in settings so a restart/retry re-adds with the same subset.
      return update(queue, action.id, i => ({
        ...i,
        settings: { ...i.settings, selectedFiles: action.files },
      }));

    case 'setCategory':
      // Re-filing something that hasn't started yet also takes the category's
      // destination and naming. Once it is running, only the label moves:
      // changing where a live download writes would strand its partial file.
      return update(queue, action.id, i => {
        if (!action.category) {
          const settings = { ...i.settings };
          delete settings.categoryId;
          delete settings.categoryName;
          return { ...i, settings };
        }
        return i.status === 'queued'
          ? applyCategory(i, action.category)
          : { ...i, settings: { ...i.settings, categoryId: action.category.id, categoryName: action.category.name } };
      });

    case 'setLabels':
      // Labels carry no settings, so unlike a category they can move at any
      // point in an item's life without consequences.
      return update(queue, action.id, i => ({
        ...i,
        settings: {
          ...i.settings,
          labelIds: action.labelIds.length > 0 ? action.labelIds : undefined,
        },
      }));

    case 'setChecksum':
      // Only while it is still queued: the engine is handed the expected hash
      // when it starts, so setting one on a download already under way would
      // promise a check that never happens.
      return update(queue, action.id, i => {
        if (i.status !== 'queued') return i;
        const settings = { ...i.settings };
        const normalised = normalizeSha256(action.sha256);
        if (normalised) settings.sha256 = normalised;
        else delete settings.sha256;
        return { ...i, settings };
      });

    case 'setWhenComplete':
      // null means "follow the setting" — distinct from 'nothing', which is a
      // decision to do nothing for this one download in particular.
      return update(queue, action.id, i => {
        const settings = { ...i.settings };
        if (action.action) settings.whenComplete = action.action;
        else delete settings.whenComplete;
        return { ...i, settings };
      });

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
