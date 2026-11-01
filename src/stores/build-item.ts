import type { DownloadItem, DownloadKind, DownloadSettings, MediaMetadata } from '@/types/models';
import { generateId } from '@/services/utils';

/** What a new queue item is made of: where it came from, and its settings. */
export interface NewItem {
  /** Absent = yt-dlp, as it always has been. */
  kind?: DownloadKind;
  metadata: MediaMetadata;
  settings: Omit<DownloadSettings, 'retryCount' | 'startImmediately'> & { startImmediately?: boolean };
  /** The size, if something already knows it (a chosen format, a history
   * row). Unknown is 0, which every view shows as unknown — not a guess. */
  totalBytes?: number;
}

/**
 * The one way a queue item is made. There were eight, and they disagreed: a
 * size placeholder of 500 MB (shown as "x / 476.8 MB" and skewing the Dock's
 * byte-weighted progress), 10 MB or 0; a retryCount copied three ways and
 * read by nothing (REVIEW 2026-09-28 A-2). An item added with "Start
 * immediately" off is held ('ready') until the user starts it.
 */
export function buildItem({ kind, metadata, settings, totalBytes }: NewItem): DownloadItem {
  const startImmediately = settings.startImmediately ?? true;
  return {
    id: generateId(),
    metadata,
    settings: { ...settings, startImmediately },
    status: startImmediately ? 'queued' : 'ready',
    progress: 0,
    speed: 0,
    eta: 0,
    downloadedBytes: 0,
    totalBytes: totalBytes && totalBytes > 0 ? totalBytes : 0,
    retryAttempt: 0,
    ...(kind ? { kind } : {}),
  };
}

/** Metadata for a link nothing has looked up yet. */
export function linkMetadata(url: string, title: string, domain: string, extra: Partial<MediaMetadata> = {}): MediaMetadata {
  return {
    title,
    duration: 0,
    thumbnail: '',
    source: { url, domain, addedAt: new Date().toISOString() },
    formats: [],
    ...extra,
  };
}
