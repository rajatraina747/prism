import type { DownloadItem } from '@/types/models';
import { generateId, torrentDisplayName, sourceKey } from '@/services/utils';

/** Build a queue item for a magnet/.torrent source. Skips yt-dlp parsing —
 * librqbit resolves the real name/size once peers deliver the metadata. */
export function buildTorrentItem(url: string, destination: string, selectedFiles?: number[]): DownloadItem {
  const title = torrentDisplayName(url);
  let domain = 'torrent';
  try { domain = new URL(url).hostname || 'magnet'; } catch { /* magnet has no host */ }
  return {
    id: generateId(),
    metadata: {
      title,
      duration: 0,
      thumbnail: '',
      source: { url, domain, addedAt: new Date().toISOString() },
      formats: [],
    },
    settings: {
      format: null,
      destination,
      filename: title,
      retryCount: 0,
      startImmediately: true,
      selectedFiles,
    },
    status: 'queued',
    progress: 0,
    speed: 0,
    eta: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    retryAttempt: 0,
    kind: 'torrent',
  };
}

/** Queue items for torrents brought over from another client: paused (so a
 * whole library doesn't start re-checking at once), each in the folder its
 * data is already in when Prism may use it, and none already in the queue. */
export function importedTorrentItems(
  torrents: { magnet: string; savePath: string | null }[],
  queue: DownloadItem[],
  defaultFolder: string,
): DownloadItem[] {
  const have = new Set(queue.map(i => sourceKey(i.metadata.source.url)));
  const items: DownloadItem[] = [];
  for (const t of torrents) {
    const key = sourceKey(t.magnet);
    if (have.has(key)) continue;
    have.add(key);
    const item = buildTorrentItem(t.magnet, t.savePath ?? defaultFolder);
    items.push({ ...item, status: 'paused', settings: { ...item.settings, startImmediately: false } });
  }
  return items;
}
