import { describe, it, expect } from 'vitest';
import { queueReducer } from '../queue-reducer';
import type { DownloadItem, DownloadError, DownloadCategory } from '@/types/models';

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

describe('queueReducer setStartAt', () => {
  const at = '2026-09-20T18:00:00.000Z';

  it('holds a queued item until the given time', () => {
    const next = queueReducer([makeItem()], { type: 'setStartAt', id: 'a', startAt: at });
    expect(next[0].settings.startAt).toBe(at);
  });

  it('clears the time when given null', () => {
    const held = queueReducer([makeItem()], { type: 'setStartAt', id: 'a', startAt: at });
    const cleared = queueReducer(held, { type: 'setStartAt', id: 'a', startAt: null });
    expect(cleared[0].settings.startAt).toBeUndefined();
    expect('startAt' in cleared[0].settings).toBe(false);
  });

  it('refuses to schedule something already running', () => {
    // A start time on a download that has started describes a moment that has
    // been and gone. Ignoring it silently is the bug this guards against.
    const running = makeItem({ status: 'downloading' });
    const next = queueReducer([running], { type: 'setStartAt', id: 'a', startAt: at });
    expect(next[0].settings.startAt).toBeUndefined();
  });

  it('leaves other items alone', () => {
    const queue = [makeItem(), makeItem({ id: 'b' })];
    const next = queueReducer(queue, { type: 'setStartAt', id: 'a', startAt: at });
    expect(next[1].settings.startAt).toBeUndefined();
  });
});

describe('queueReducer setClip', () => {
  const clip = (
    queue: DownloadItem[],
    clipStart: string | null,
    clipEnd: string | null,
    splitChapters = false,
  ) => queueReducer(queue, { type: 'setClip', id: 'a', clipStart, clipEnd, splitChapters });

  it('records both ends of the range', () => {
    const next = clip([makeItem()], '1:23', '2:34');
    expect(next[0].settings.clipStart).toBe('1:23');
    expect(next[0].settings.clipEnd).toBe('2:34');
  });

  it('keeps one end when only one is given', () => {
    const next = clip([makeItem()], '1:23', null);
    expect(next[0].settings.clipStart).toBe('1:23');
    expect('clipEnd' in next[0].settings).toBe(false);
  });

  it('clears the range rather than storing empty values', () => {
    const set = clip([makeItem()], '1:23', '2:34');
    const cleared = clip(set, null, null);
    expect('clipStart' in cleared[0].settings).toBe(false);
    expect('clipEnd' in cleared[0].settings).toBe(false);
  });

  it('sets and unsets splitting by chapter', () => {
    const on = clip([makeItem()], null, null, true);
    expect(on[0].settings.splitChapters).toBe(true);
    const off = clip(on, null, null, false);
    expect('splitChapters' in off[0].settings).toBe(false);
  });

  it('refuses to change a download already running', () => {
    // A range describes which part to fetch; one already downloading is past
    // choosing. A silently ignored guard looks just like a working one.
    const running = makeItem({ status: 'downloading' });
    const next = clip([running], '1:23', '2:34');
    expect(next[0].settings.clipStart).toBeUndefined();
  });

  it('leaves other items alone', () => {
    const next = clip([makeItem(), makeItem({ id: 'b' })], '1:23', '2:34');
    expect(next[1].settings.clipStart).toBeUndefined();
  });
});

describe('queueReducer', () => {
  it('adds items', () => {
    const next = queueReducer([], { type: 'add', item: makeItem() });
    expect(next).toHaveLength(1);
  });

  it('re-files a queued item into a category, taking its destination and naming', () => {
    const music: DownloadCategory = {
      id: 'music', name: 'Music', destination: '~/Music',
      filenameTemplate: '{uploader}/{title}', domains: [], kinds: [],
    };
    const next = queueReducer([makeItem()], { type: 'setCategory', id: 'a', category: music });
    expect(next[0].settings.categoryId).toBe('music');
    expect(next[0].settings.destination).toBe('~/Music');
    expect(next[0].settings.filenameTemplate).toBe('{uploader}/{title}');
  });

  it('only labels an item that is already running — its destination stays put', () => {
    const music: DownloadCategory = {
      id: 'music', name: 'Music', destination: '~/Music', filenameTemplate: '', domains: [], kinds: [],
    };
    const next = queueReducer([makeItem({ status: 'downloading' })], { type: 'setCategory', id: 'a', category: music });
    expect(next[0].settings.categoryName).toBe('Music');
    expect(next[0].settings.destination).toBe('~/Downloads/Prism');
  });

  it('clears a category without disturbing the rest of the settings', () => {
    const base = makeItem();
    const filed = makeItem({ settings: { ...base.settings, categoryId: 'music', categoryName: 'Music' } });
    const next = queueReducer([filed], { type: 'setCategory', id: 'a', category: null });
    expect(next[0].settings.categoryId).toBeUndefined();
    expect(next[0].settings.categoryName).toBeUndefined();
    expect(next[0].settings.destination).toBe('~/Downloads/Prism');
  });

  it('tags an item with labels at any point, and forgets the key when the last goes', () => {
    const tagged = queueReducer([makeItem({ status: 'downloading' })], { type: 'setLabels', id: 'a', labelIds: ['l1', 'l2'] });
    expect(tagged[0].settings.labelIds).toEqual(['l1', 'l2']);
    const cleared = queueReducer(tagged, { type: 'setLabels', id: 'a', labelIds: [] });
    expect(cleared[0].settings.labelIds).toBeUndefined();
  });

  it('takes an expected checksum while queued, in whatever shape it was pasted', () => {
    const hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const set = queueReducer([makeItem({ kind: 'direct' })], { type: 'setChecksum', id: 'a', sha256: hash.toUpperCase() });
    expect(set[0].settings.sha256).toBe(hash);

    const cleared = queueReducer(set, { type: 'setChecksum', id: 'a', sha256: null });
    expect(cleared[0].settings.sha256).toBeUndefined();

    // A typo is refused rather than stored as a check that can never pass.
    const rejected = queueReducer(set, { type: 'setChecksum', id: 'a', sha256: 'not-a-hash' });
    expect(rejected[0].settings.sha256).toBeUndefined();
  });

  it('refuses a checksum once the download is under way', () => {
    const hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const running = queueReducer([makeItem({ kind: 'direct', status: 'downloading' })], { type: 'setChecksum', id: 'a', sha256: hash });
    expect(running[0].settings.sha256).toBeUndefined();
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
        data: { progress: 100, speed: 0, uploadSpeed: 2048, peers: 12, ratio: 0.3 },
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

describe('torrent parity fields', () => {
  it('applies peerlessSecs, uploadedBytes and pieces from progress and keeps pieces when omitted', () => {
    const items = [makeItem({ id: 't', kind: 'torrent', status: 'downloading' })];
    let next = queueReducer(items, { type: 'progress', id: 't', data: { peerlessSecs: 30, uploadedBytes: 1000, pieces: [255, 0] } });
    expect(next[0].peerlessSecs).toBe(30);
    expect(next[0].uploadedBytes).toBe(1000);
    expect(next[0].pieces).toEqual([255, 0]);
    next = queueReducer(next, { type: 'progress', id: 't', data: { progress: 5 } });
    expect(next[0].pieces).toEqual([255, 0]);
  });

  it('retry keeps the real size and lifetime upload but resets the peerless clock', () => {
    const items = [makeItem({ id: 't', kind: 'torrent', status: 'failed', totalBytes: 11_000_000_000, uploadedBytes: 5000, peerlessSecs: 900, progress: 2 })];
    const next = queueReducer(items, { type: 'retry', id: 't' });
    expect(next[0].status).toBe('queued');
    expect(next[0].totalBytes).toBe(11_000_000_000);
    expect(next[0].uploadedBytes).toBe(5000);
    expect(next[0].peerlessSecs).toBe(0);
    expect(next[0].progress).toBe(0);
  });

  it('stamps addedAt on add when missing', () => {
    const next = queueReducer([], { type: 'add', item: makeItem({ id: 'n' }) });
    expect(typeof next[0].addedAt).toBe('string');
    const kept = queueReducer([], { type: 'add', item: makeItem({ id: 'k', addedAt: '2026-01-01T00:00:00.000Z' }) });
    expect(kept[0].addedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
