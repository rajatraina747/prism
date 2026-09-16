import { describe, it, expect } from 'vitest';
import { overallProgress } from '../progress';
import type { DownloadItem, DownloadStatus } from '@/types/models';

function item(partial: {
  id: string;
  status: DownloadStatus;
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
}): DownloadItem {
  return {
    id: partial.id,
    metadata: {
      title: partial.id,
      duration: 0,
      thumbnail: '',
      source: { url: `https://example.com/${partial.id}`, domain: 'example.com', addedAt: '2026-01-01T00:00:00.000Z' },
      formats: [],
    },
    settings: {
      format: null,
      destination: '/tmp',
      filename: partial.id,
      retryCount: 0,
      startImmediately: true,
    },
    status: partial.status,
    progress: partial.progress ?? 0,
    speed: 0,
    eta: 0,
    downloadedBytes: partial.downloadedBytes ?? 0,
    totalBytes: partial.totalBytes ?? 0,
    retryAttempt: 0,
  };
}

describe('overallProgress', () => {
  it('shows nothing when there is nothing to show', () => {
    expect(overallProgress([])).toBeNull();
    expect(overallProgress([item({ id: 'a', status: 'completed' })])).toBeNull();
  });

  it('ignores seeding torrents', () => {
    // The download is done; a bar stuck at 100% is worse than no bar.
    expect(overallProgress([item({ id: 'a', status: 'seeding', progress: 100 })])).toBeNull();
  });

  it('weights by bytes when every size is known', () => {
    // 900 of 1000 bytes overall — not the 55% a naive mean of 10% and 100%
    // would give, which is the point of weighting.
    const big = item({ id: 'big', status: 'downloading', downloadedBytes: 800, totalBytes: 900, progress: 89 });
    const small = item({ id: 'small', status: 'downloading', downloadedBytes: 100, totalBytes: 100, progress: 100 });
    expect(overallProgress([big, small])).toEqual({ percent: 90, paused: false });
  });

  it('falls back to the mean when a size is still unknown', () => {
    // A torrent with no peers yet has no total; mixing scales would make the
    // bar jump backwards the moment the size arrives.
    const known = item({ id: 'a', status: 'downloading', downloadedBytes: 50, totalBytes: 100, progress: 50 });
    const unknown = item({ id: 'b', status: 'downloading', progress: 10, totalBytes: 0 });
    expect(overallProgress([known, unknown])).toEqual({ percent: 30, paused: false });
  });

  it('counts queued work as unfinished rather than absent', () => {
    const queued = item({ id: 'q', status: 'queued', progress: 0 });
    expect(overallProgress([queued])).toEqual({ percent: 0, paused: false });
  });

  it('reports a paused state when nothing is running but work remains', () => {
    const paused = item({ id: 'p', status: 'paused', progress: 40 });
    expect(overallProgress([paused])).toEqual({ percent: 40, paused: true });
  });

  it('prefers running work over paused work', () => {
    const running = item({ id: 'r', status: 'downloading', progress: 20 });
    const paused = item({ id: 'p', status: 'paused', progress: 90 });
    expect(overallProgress([running, paused])).toEqual({ percent: 20, paused: false });
  });

  it('never returns a percentage outside 0-100', () => {
    // Bad numbers from an engine must not reach an OS API.
    const odd = item({ id: 'odd', status: 'downloading', downloadedBytes: 500, totalBytes: 100 });
    expect(overallProgress([odd])?.percent).toBe(100);
    const nan = item({ id: 'nan', status: 'downloading', progress: Number.NaN });
    expect(overallProgress([nan])?.percent).toBe(0);
  });
});
