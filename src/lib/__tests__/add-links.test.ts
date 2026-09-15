import { describe, it, expect, vi } from 'vitest';
import { extractLinks, linksFromDrop } from '../add-links';

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';

function transfer(files: File[], data: Record<string, string> = {}) {
  return { files: files as unknown as FileList, getData: (t: string) => data[t] ?? '' };
}

describe('extractLinks', () => {
  it('keeps http(s) and magnet links, de-duplicated, in order', () => {
    const text = `https://a.example/1\n  junk ftp://x\n${MAGNET} https://a.example/1\thttp://b.example/2`;
    expect(extractLinks(text)).toEqual(['https://a.example/1', MAGNET, 'http://b.example/2']);
    expect(extractLinks('nothing here')).toEqual([]);
  });
});

describe('linksFromDrop', () => {
  it('turns a dropped .torrent into the magnet the backend returns', async () => {
    const importTorrent = vi.fn(async () => MAGNET);
    const file = new File([new Uint8Array([100, 101])], 'Pack.torrent');
    const r = await linksFromDrop(transfer([file]), importTorrent);
    expect(importTorrent).toHaveBeenCalledWith('Pack.torrent', new Uint8Array([100, 101]));
    expect(r).toEqual({ links: [MAGNET], errors: [] });
  });

  it('reads links out of a text file and reports unaddable files', async () => {
    const list = new File(['https://a.example/1\nhttps://a.example/2'], 'links.txt', { type: 'text/plain' });
    const image = new File(['x'], 'photo.png', { type: 'image/png' });
    const r = await linksFromDrop(transfer([list, image]), vi.fn());
    expect(r.links).toEqual(['https://a.example/1', 'https://a.example/2']);
    expect(r.errors).toEqual([expect.stringContaining('photo.png')]);
  });

  it('takes dragged links, skipping uri-list comments', async () => {
    const r = await linksFromDrop(
      transfer([], { 'text/uri-list': '# comment\nhttps://a.example/v', 'text/plain': 'https://a.example/v' }),
      vi.fn(),
    );
    expect(r).toEqual({ links: ['https://a.example/v'], errors: [] });
  });

  it('surfaces a rejected .torrent as an error', async () => {
    const r = await linksFromDrop(transfer([new File(['x'], 'bad.torrent')]), async () => { throw new Error('bad.torrent is not a valid .torrent file'); });
    expect(r).toEqual({ links: [], errors: ['bad.torrent is not a valid .torrent file'] });
  });
});
