import type { DownloadItem, HistoryItem } from '@/types/models';

// The desktop app's queue lives in Rust (src-tauri/src/queue.rs); the page
// keeps a copy to render, kept current by the patches Rust sends. Pure, so
// the one rule that matters — a patch applies exactly, in order — is tested.

/** What `queue-changed` carries: the items that changed (whole), the ones
 * removed, and the new order when it moved. */
export interface QueuePatch {
  items: DownloadItem[];
  removed: string[];
  order?: string[];
}

/** What `queue-archived` carries for each item that moved to the Library. */
export interface ArchivedEntry {
  history: HistoryItem;
  item: DownloadItem;
}

/** What `queue-notice` carries (queue.rs `Notice`). */
export interface QueueNotice {
  kind: 'completed' | 'failed' | 'quality' | 'skipped';
  id: string;
  title: string;
  message?: string;
  engineCode?: import('@/services/errors').EngineErrorCode;
  requested?: number;
  actual?: number;
}

export type RemoteQueueAction =
  | { type: 'snapshot'; items: DownloadItem[] }
  | { type: 'patch'; patch: QueuePatch };

export function applyQueuePatch(queue: DownloadItem[], patch: QueuePatch): DownloadItem[] {
  const removed = new Set(patch.removed);
  const changed = new Map(patch.items.map(i => [i.id, i]));
  let next = queue.filter(i => !removed.has(i.id)).map(i => changed.get(i.id) ?? i);
  // Items new to the page (added, or changed before it saw them).
  const known = new Set(next.map(i => i.id));
  for (const item of patch.items) {
    if (!known.has(item.id) && !removed.has(item.id)) next.push(item);
  }
  if (patch.order) {
    const at = new Map(patch.order.map((id, n) => [id, n]));
    next = [...next].sort((a, b) => (at.get(a.id) ?? Infinity) - (at.get(b.id) ?? Infinity));
  }
  return next;
}

export function remoteQueueReducer(queue: DownloadItem[], action: RemoteQueueAction): DownloadItem[] {
  switch (action.type) {
    case 'snapshot':
      return action.items;
    case 'patch':
      return applyQueuePatch(queue, action.patch);
  }
}
