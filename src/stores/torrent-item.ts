import type { DownloadItem } from '@/types/models';
import { torrentDisplayName, sourceKey } from '@/services/utils';
import { buildItem, linkMetadata } from '@/stores/build-item';

/** Build a queue item for a magnet/.torrent source. Skips yt-dlp parsing —
 * librqbit resolves the real name/size once peers deliver the metadata. */
export function buildTorrentItem(url: string, destination: string, selectedFiles?: number[]): DownloadItem {
  const title = torrentDisplayName(url);
  let domain = 'torrent';
  try { domain = new URL(url).hostname || 'magnet'; } catch { /* magnet has no host */ }
  return buildItem({
    kind: 'torrent',
    metadata: linkMetadata(url, title, domain),
    settings: { format: null, destination, filename: title, selectedFiles },
  });
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

/** Absolute(ish) path of one file inside a torrent download. File names are
 * relative to the folder the engine wrote into (`outputFolder`; a multi-file
 * torrent gets its own folder), or to the destination itself for items
 * recorded before 1.8.1. */
export function torrentFilePath(
  item: { outputFolder?: string; settings: { destination?: string } },
  name: string,
): string {
  const dest = (item.outputFolder || item.settings.destination || '~/Downloads/Prism').replace(/\/+$/, '');
  return `${dest}/${name}`;
}
