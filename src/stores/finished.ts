import type { DownloadItem } from '@/types/models';

// Downloads Rust saw finish (src-tauri/src/finished.rs), applied to the queue
// as it loads, before anything can start. If the page's last save never
// landed, an item that finished is still `queued` in queue.json, and it
// would download again. Idempotent: an item already completed, or already
// moved to the Library, is left alone.

export interface FinishedDownload {
  id: string;
  completedAt: string;
  filePath?: string;
  fileSize?: number;
  outputFolder?: string;
}

const DONE: DownloadItem['status'][] = ['completed', 'failed', 'canceled'];

/** `inLibrary` are ids the Library already holds: in the original bug the
 * Library's save landed and the queue's didn't, and marking such an item
 * completed would archive it a second time, so it's dropped instead. */
export function applyFinished(queue: DownloadItem[], finished: FinishedDownload[], inLibrary: Set<string> = new Set()): DownloadItem[] {
  if (finished.length === 0) return queue;
  const byId = new Map(finished.map(f => [f.id, f]));
  let changed = false;
  const kept = queue.filter(item => {
    const drop = byId.has(item.id) && inLibrary.has(item.id) && !DONE.includes(item.status);
    if (drop) changed = true;
    return !drop;
  });
  const next = kept.map(item => {
    const done = byId.get(item.id);
    if (!done || DONE.includes(item.status)) return item;
    changed = true;
    return {
      ...item,
      status: 'completed' as const,
      progress: 100,
      speed: 0,
      eta: 0,
      uploadSpeed: 0,
      completedAt: done.completedAt,
      filePath: done.filePath ?? item.filePath,
      totalBytes: done.fileSize ?? item.totalBytes,
      outputFolder: done.outputFolder ?? item.outputFolder,
    };
  });
  return changed ? next : queue;
}
