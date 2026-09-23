import type { DownloadItem, DownloadStatus, HistoryItem } from '@/types/models';
import { sourceKey } from '@/services/utils';

// "Is this already here?" at two moments. Before a lookup only the URL is
// known, and `sourceKey` normalises the ones it can (magnet infohash, YouTube
// id). After yt-dlp has looked the link up, `mediaKey` (extractor + the
// site's own id) catches the same video on any site, however its URL was
// written: a Vimeo player link and its page, a short link and the full one.

const ACTIVE_STATUSES: DownloadStatus[] = ['queued', 'parsing', 'ready', 'downloading', 'seeding', 'paused'];

export type Duplicate = 'queue' | 'completed' | null;

/** Is this source already in the active queue or completed history? */
export function findDuplicate(url: string, queue: DownloadItem[], history: HistoryItem[]): Duplicate {
  const key = sourceKey(url);
  if (queue.some(i => ACTIVE_STATUSES.includes(i.status) && sourceKey(i.metadata.source.url) === key)) return 'queue';
  if (history.some(i => i.status === 'completed' && sourceKey(i.metadata.source.url) === key)) return 'completed';
  return null;
}

/** The same check by `mediaKey`, once a lookup has produced one. */
export function findMediaDuplicate(mediaKey: string | undefined, queue: DownloadItem[], history: HistoryItem[]): Duplicate {
  if (!mediaKey) return null;
  if (queue.some(i => ACTIVE_STATUSES.includes(i.status) && i.metadata.mediaKey === mediaKey)) return 'queue';
  if (history.some(i => i.status === 'completed' && i.metadata.mediaKey === mediaKey)) return 'completed';
  return null;
}
