import { describe, it, expect } from 'vitest';
import { buildTorrentItem, importedTorrentItems } from '../torrent-item';

const A = 'magnet:?xt=urn:btih:AAAA&dn=Show';
const B = 'magnet:?xt=urn:btih:bbbb&dn=Film';

describe('importedTorrentItems', () => {
  it('adds each torrent paused, in its own folder or the default', () => {
    const items = importedTorrentItems(
      [{ magnet: A, savePath: '/Volumes/Media/TV' }, { magnet: B, savePath: null }],
      [],
      '~/Downloads/Prism',
    );
    expect(items.map(i => [i.status, i.settings.destination, i.kind])).toEqual([
      ['paused', '/Volumes/Media/TV', 'torrent'],
      ['paused', '~/Downloads/Prism', 'torrent'],
    ]);
    expect(items.every(i => i.settings.startImmediately === false)).toBe(true);
  });

  it('skips torrents already in the queue, and duplicates within the import', () => {
    const queued = buildTorrentItem('magnet:?xt=urn:btih:aaaa', '/dl');
    const items = importedTorrentItems([{ magnet: A, savePath: null }, { magnet: B, savePath: null }, { magnet: B, savePath: null }], [queued], '/dl');
    expect(items.map(i => i.metadata.source.url)).toEqual([B]);
  });
});
