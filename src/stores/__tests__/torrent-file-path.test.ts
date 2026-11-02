import { describe, expect, it } from 'vitest';
import { torrentFilePath } from '../torrent-item';

describe('torrentFilePath', () => {
  it("prefers the torrent's own folder over the destination", () => {
    expect(torrentFilePath({ outputFolder: '/d/Pack/', settings: { destination: '/d' } }, 'a/b.mkv')).toBe('/d/Pack/a/b.mkv');
  });
  it('falls back to the destination for older items', () => {
    expect(torrentFilePath({ settings: { destination: '/d' } }, 'b.mkv')).toBe('/d/b.mkv');
  });
});
