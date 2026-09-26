import { describe, it, expect } from 'vitest';
import { itemsToStart, isSlowTorrent, SLOW_TORRENT_SECS } from '@/stores/slots';
import type { DownloadItem } from '@/types/models';

const NOW = new Date('2026-09-26T12:00:00Z');
const ago = (secs: number) => new Date(NOW.getTime() - secs * 1000).toISOString();

function item(id: string, over: Partial<DownloadItem>): DownloadItem {
  return {
    id,
    metadata: { title: id, duration: 0, thumbnail: '', source: { url: `https://x/${id}`, domain: 'x', addedAt: ago(0) }, formats: [] },
    settings: { format: null, destination: '/d', filename: id, retryCount: 0, startImmediately: true },
    status: 'queued', progress: 0, speed: 0, eta: 0, downloadedBytes: 0, totalBytes: 0, retryAttempt: 0,
    ...over,
  };
}

const all = () => true;

describe('itemsToStart', () => {
  // Regression (REVIEW 2026-09-26): dead magnets held every slot.
  it('stalled torrents no longer block a video', () => {
    const dead = [1, 2, 3].map(i => item(`t${i}`, { kind: 'torrent', status: 'downloading', peerlessSecs: SLOW_TORRENT_SECS, startedAt: ago(900) }));
    const video = item('v', { kind: 'http' });
    const picked = itemsToStart([...dead, video], { transfers: 3, torrents: 3 }, NOW, all);
    expect(picked.map(i => i.id)).toEqual(['v']);
  });

  it('keeps separate pools for torrents and everything else', () => {
    const running = item('t0', { kind: 'torrent', status: 'downloading', speed: 500_000, startedAt: ago(60) });
    const queue = [running, item('t1', { kind: 'torrent' }), item('t2', { kind: 'torrent' }), item('v1', { kind: 'http' }), item('d1', { kind: 'direct' })];
    const picked = itemsToStart(queue, { transfers: 1, torrents: 2 }, NOW, all);
    expect(picked.map(i => i.id)).toEqual(['t1', 'v1']);
  });

  it('frees the slot of a slow torrent so the next one can start', () => {
    const slow = item('t0', { kind: 'torrent', status: 'downloading', speed: 10, startedAt: ago(SLOW_TORRENT_SECS + 1) });
    const picked = itemsToStart([slow, item('t1', { kind: 'torrent' })], { transfers: 3, torrents: 1 }, NOW, all);
    expect(picked.map(i => i.id)).toEqual(['t1']);
  });

  it('respects what may not start yet', () => {
    const picked = itemsToStart([item('a', {}), item('b', {})], { transfers: 3, torrents: 3 }, NOW, i => i.id !== 'a');
    expect(picked.map(i => i.id)).toEqual(['b']);
  });
});

describe('isSlowTorrent', () => {
  it('a fresh torrent still finding peers is not slow', () => {
    expect(isSlowTorrent(item('t', { kind: 'torrent', status: 'downloading', speed: 0, startedAt: ago(30) }), NOW)).toBe(false);
  });
  it('seeding and non-torrents never are', () => {
    expect(isSlowTorrent(item('t', { kind: 'torrent', status: 'seeding', peerlessSecs: 9999 }), NOW)).toBe(false);
    expect(isSlowTorrent(item('v', { kind: 'http', status: 'downloading', startedAt: ago(9999) }), NOW)).toBe(false);
  });
});
