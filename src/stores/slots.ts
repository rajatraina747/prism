import type { DownloadItem } from '@/types/models';

// Which queued items may start now.
//
// Torrents used to share one pool with everything else, so a few magnets
// with no peers held every slot and a YouTube download waited behind them for
// good (REVIEW 2026-09-26). Torrents now have their own limit, and one that
// has been stalled for a while stops counting against it — qBittorrent's
// "don't count slow torrents" — so the next can try its luck.

/** A torrent this long without peers, or without meaningful speed, is slow. */
export const SLOW_TORRENT_SECS = 5 * 60;
/** Below this download speed (bytes/s) a torrent isn't really moving. */
export const SLOW_TORRENT_BPS = 1024;

/** A running torrent that has stalled long enough not to hold a slot. */
export function isSlowTorrent(item: DownloadItem, now: Date): boolean {
  if (item.kind !== 'torrent' || item.status !== 'downloading') return false;
  if ((item.peerlessSecs ?? 0) >= SLOW_TORRENT_SECS) return true;
  const started = item.startedAt ? Date.parse(item.startedAt) : NaN;
  const runningFor = Number.isFinite(started) ? (now.getTime() - started) / 1000 : 0;
  return runningFor >= SLOW_TORRENT_SECS && item.speed < SLOW_TORRENT_BPS;
}

export interface SlotLimits {
  /** Videos, direct downloads and conversions. */
  transfers: number;
  torrents: number;
}

/** Queued items to start now, in queue order, within each pool's free slots.
 * `startable` filters what may start at all (not already starting, not held). */
export function itemsToStart(
  queue: DownloadItem[],
  limits: SlotLimits,
  now: Date,
  startable: (item: DownloadItem) => boolean,
): DownloadItem[] {
  let freeTransfers = limits.transfers;
  let freeTorrents = limits.torrents;
  for (const item of queue) {
    if (item.status !== 'downloading') continue;
    if (item.kind === 'torrent') {
      if (!isSlowTorrent(item, now)) freeTorrents--;
    } else {
      freeTransfers--;
    }
  }
  const picked: DownloadItem[] = [];
  for (const item of queue) {
    if (item.status !== 'queued' || !startable(item)) continue;
    if (item.kind === 'torrent') {
      if (freeTorrents > 0) { freeTorrents--; picked.push(item); }
    } else if (freeTransfers > 0) {
      freeTransfers--;
      picked.push(item);
    }
  }
  return picked;
}
