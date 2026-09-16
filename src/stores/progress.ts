import type { DownloadItem, DownloadStatus } from '@/types/models';

// What the Dock (macOS) and taskbar (Windows) show while Prism is working.
// Pure, so the rule for "how far along is everything" is testable and lives in
// one place rather than being re-derived wherever it is displayed.

/** Statuses that count as work in progress.
 *
 * Seeding is deliberately not here: the download is finished, and a progress
 * bar that never leaves 100% (or restarts) is worse than no bar. */
const WORKING: DownloadStatus[] = ['downloading', 'queued', 'parsing', 'ready'];

export interface OverallProgress {
  /** 0–100, rounded — the scale the OS progress APIs take. */
  percent: number;
  /** Nothing is running, but something is paused and could resume. */
  paused: boolean;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Mean of each item's own progress, for when sizes aren't known yet. */
function meanPercent(items: DownloadItem[]): number {
  if (items.length === 0) return 0;
  const total = items.reduce((sum, i) => sum + (Number.isFinite(i.progress) ? i.progress : 0), 0);
  return clampPercent(total / items.length);
}

/** How far along everything is, or null when there is nothing to show.
 *
 * Weighted by bytes when every working item knows its size, so one large
 * download isn't drowned out by several small ones. When any size is still
 * unknown — a torrent before it has peers, a video before yt-dlp reports —
 * it falls back to the mean of the items' own percentages rather than mixing
 * two scales and producing a number that jumps when a size arrives. */
export function overallProgress(items: DownloadItem[]): OverallProgress | null {
  const working = items.filter(i => WORKING.includes(i.status));

  if (working.length === 0) {
    const paused = items.filter(i => i.status === 'paused');
    // Paused work still deserves a bar — it says "unfinished", not "idle".
    return paused.length > 0 ? { percent: meanPercent(paused), paused: true } : null;
  }

  const allSizesKnown = working.every(i => i.totalBytes > 0);
  if (!allSizesKnown) return { percent: meanPercent(working), paused: false };

  const downloaded = working.reduce((sum, i) => sum + (i.downloadedBytes || 0), 0);
  const total = working.reduce((sum, i) => sum + i.totalBytes, 0);
  return { percent: clampPercent((downloaded / total) * 100), paused: false };
}
