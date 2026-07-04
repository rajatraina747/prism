import { describe, it, expect } from 'vitest';
import { queueReducer } from '../queue-reducer';
import type { DownloadItem, DownloadError } from '@/types/models';

function makeItem(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'a',
    metadata: {
      title: 'Test Video',
      duration: 60,
      thumbnail: '',
      source: { url: 'https://example.com/v', domain: 'example.com', addedAt: '2026-07-03T00:00:00Z' },
      formats: [],
    },
    settings: {
      format: null,
      destination: '~/Downloads/Prism',
      filename: 'Test Video',
      retryCount: 3,
      startImmediately: true,
    },
    status: 'queued',
    progress: 0,
    speed: 0,
    eta: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    retryAttempt: 0,
    ...overrides,
  };
}

const err: DownloadError = {
  code: 'DOWNLOAD_FAILED',
  message: 'boom',
  category: 'network',
  timestamp: '2026-07-03T00:00:00Z',
};

describe('queueReducer', () => {
  it('adds items', () => {
    const next = queueReducer([], { type: 'add', item: makeItem() });
    expect(next).toHaveLength(1);
  });

  it('marks queued items started, but not paused ones', () => {
    const started = queueReducer([makeItem()], { type: 'markStarted', id: 'a', startedAt: 't' });
    expect(started[0].status).toBe('downloading');
    expect(started[0].startedAt).toBe('t');

    const paused = queueReducer([makeItem({ status: 'paused' })], { type: 'markStarted', id: 'a', startedAt: 't' });
    expect(paused[0].status).toBe('paused');
  });

  it('applies progress only while downloading', () => {
    const data = { progress: 50, downloadedBytes: 500, totalBytes: 1000, speed: 10, eta: 5 };
    const active = queueReducer([makeItem({ status: 'downloading' })], { type: 'progress', id: 'a', data });
    expect(active[0].progress).toBe(50);

    // Stale progress event arriving after a pause must not resurrect counters
    const stale = queueReducer([makeItem({ status: 'paused' })], { type: 'progress', id: 'a', data });
    expect(stale[0].progress).toBe(0);
  });

  it('completes a downloading item and zeroes live counters', () => {
    const item = makeItem({ status: 'downloading', speed: 10, eta: 5, totalBytes: 100 });
    const next = queueReducer([item], { type: 'completed', id: 'a', completedAt: 't', filePath: '/x.mp4', fileSize: 999 });
    expect(next[0]).toMatchObject({ status: 'completed', progress: 100, speed: 0, eta: 0, filePath: '/x.mp4', totalBytes: 999 });
  });

  it('ignores completion that races a user cancel', () => {
    const next = queueReducer([makeItem({ status: 'canceled' })], { type: 'completed', id: 'a', completedAt: 't' });
    expect(next[0].status).toBe('canceled');
  });

  it('fails downloading and queued items, but a pause wins the race', () => {
    expect(queueReducer([makeItem({ status: 'downloading' })], { type: 'failed', id: 'a', error: err })[0].status).toBe('failed');
    expect(queueReducer([makeItem({ status: 'queued' })], { type: 'failed', id: 'a', error: err })[0].status).toBe('failed');
    expect(queueReducer([makeItem({ status: 'paused' })], { type: 'failed', id: 'a', error: err })[0].status).toBe('paused');
  });

  it('requeues for retry only while downloading — user cancel during the backoff wait wins', () => {
    const active = queueReducer(
      [makeItem({ status: 'downloading', retryAttempt: 0, progress: 40, downloadedBytes: 400 })],
      { type: 'requeueForRetry', id: 'a' },
    );
    expect(active[0]).toMatchObject({ status: 'queued', retryAttempt: 1, progress: 0, downloadedBytes: 0 });

    const canceled = queueReducer([makeItem({ status: 'canceled' })], { type: 'requeueForRetry', id: 'a' });
    expect(canceled[0].status).toBe('canceled');
    const paused = queueReducer([makeItem({ status: 'paused' })], { type: 'requeueForRetry', id: 'a' });
    expect(paused[0].status).toBe('paused');
  });

  it('pauses queued and downloading items only', () => {
    expect(queueReducer([makeItem({ status: 'downloading', speed: 9 })], { type: 'pause', id: 'a' })[0]).toMatchObject({ status: 'paused', speed: 0 });
    expect(queueReducer([makeItem({ status: 'queued' })], { type: 'pause', id: 'a' })[0].status).toBe('paused');
    expect(queueReducer([makeItem({ status: 'failed' })], { type: 'pause', id: 'a' })[0].status).toBe('failed');
  });

  it('resumes only paused items', () => {
    expect(queueReducer([makeItem({ status: 'paused' })], { type: 'resume', id: 'a' })[0].status).toBe('queued');
    expect(queueReducer([makeItem({ status: 'failed' })], { type: 'resume', id: 'a' })[0].status).toBe('failed');
  });

  it('cancels anything except completed items', () => {
    expect(queueReducer([makeItem({ status: 'downloading' })], { type: 'cancel', id: 'a' })[0].status).toBe('canceled');
    expect(queueReducer([makeItem({ status: 'completed' })], { type: 'cancel', id: 'a' })[0].status).toBe('completed');
  });

  it('retry resets counters and increments the attempt', () => {
    const next = queueReducer(
      [makeItem({ status: 'failed', error: err, progress: 80, retryAttempt: 2 })],
      { type: 'retry', id: 'a' },
    );
    expect(next[0]).toMatchObject({ status: 'queued', retryAttempt: 3, progress: 0, error: undefined });
  });

  it('removes single items and batches', () => {
    const items = [makeItem({ id: 'a' }), makeItem({ id: 'b' }), makeItem({ id: 'c' })];
    expect(queueReducer(items, { type: 'remove', id: 'b' }).map(i => i.id)).toEqual(['a', 'c']);
    expect(queueReducer(items, { type: 'removeMany', ids: ['a', 'c'] }).map(i => i.id)).toEqual(['b']);
  });

  it('clearCompleted keeps everything else', () => {
    const items = [makeItem({ id: 'a', status: 'completed' }), makeItem({ id: 'b', status: 'failed' })];
    expect(queueReducer(items, { type: 'clearCompleted' }).map(i => i.id)).toEqual(['b']);
  });

  it('startAll requeues paused items only; pauseAll pauses downloading items only', () => {
    const items = [
      makeItem({ id: 'a', status: 'paused' }),
      makeItem({ id: 'b', status: 'downloading' }),
      makeItem({ id: 'c', status: 'failed' }),
    ];
    expect(queueReducer(items, { type: 'startAll' }).map(i => i.status)).toEqual(['queued', 'downloading', 'failed']);
    expect(queueReducer(items, { type: 'pauseAll' }).map(i => i.status)).toEqual(['paused', 'paused', 'failed']);
  });

  it('reorders items and ignores out-of-range indices', () => {
    const items = [makeItem({ id: 'a' }), makeItem({ id: 'b' }), makeItem({ id: 'c' })];
    expect(queueReducer(items, { type: 'reorder', from: 0, to: 2 }).map(i => i.id)).toEqual(['b', 'c', 'a']);
    expect(queueReducer(items, { type: 'reorder', from: 9, to: 0 }).map(i => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves other items untouched by id-targeted actions', () => {
    const items = [makeItem({ id: 'a', status: 'downloading' }), makeItem({ id: 'b', status: 'downloading' })];
    const next = queueReducer(items, { type: 'cancel', id: 'a' });
    expect(next[1].status).toBe('downloading');
  });

  describe('torrents / seeding', () => {
    it('progress with seeding flag moves a downloading torrent to seeding and applies swarm stats', () => {
      const items = [makeItem({ id: 't', kind: 'torrent', status: 'downloading' })];
      const next = queueReducer(items, {
        type: 'progress',
        id: 't',
        data: { progress: 100, speed: 0, uploadSpeed: 2048, peers: 12, seeds: 4, ratio: 0.3 },
        seeding: true,
      });
      expect(next[0].status).toBe('seeding');
      expect(next[0].uploadSpeed).toBe(2048);
      expect(next[0].peers).toBe(12);
      expect(next[0].ratio).toBe(0.3);
    });

    it('keeps applying stats while seeding without reverting to downloading', () => {
      const items = [makeItem({ id: 't', kind: 'torrent', status: 'seeding', ratio: 0.5 })];
      const next = queueReducer(items, { type: 'progress', id: 't', data: { ratio: 0.9, peers: 3 } });
      expect(next[0].status).toBe('seeding');
      expect(next[0].ratio).toBe(0.9);
    });

    it('completes from seeding and zeroes the upload speed', () => {
      const items = [makeItem({ id: 't', kind: 'torrent', status: 'seeding', uploadSpeed: 5000 })];
      const next = queueReducer(items, { type: 'completed', id: 't', completedAt: 'now', filePath: '/x.iso' });
      expect(next[0].status).toBe('completed');
      expect(next[0].uploadSpeed).toBe(0);
      expect(next[0].filePath).toBe('/x.iso');
    });

    it('pause and pauseAll stop a seeding torrent', () => {
      const seeding = [makeItem({ id: 't', kind: 'torrent', status: 'seeding', uploadSpeed: 5000 })];
      expect(queueReducer(seeding, { type: 'pause', id: 't' })[0].status).toBe('paused');
      expect(queueReducer(seeding, { type: 'pauseAll' })[0].status).toBe('paused');
      expect(queueReducer(seeding, { type: 'pause', id: 't' })[0].uploadSpeed).toBe(0);
    });

    it('cancel wins over a seeding torrent', () => {
      const items = [makeItem({ id: 't', kind: 'torrent', status: 'seeding' })];
      expect(queueReducer(items, { type: 'cancel', id: 't' })[0].status).toBe('canceled');
    });

    it('does not start seeding for a paused item that gets a stray progress event', () => {
      const items = [makeItem({ id: 't', kind: 'torrent', status: 'paused' })];
      const next = queueReducer(items, { type: 'progress', id: 't', data: { progress: 100 }, seeding: true });
      expect(next[0].status).toBe('paused');
    });
  });
});
