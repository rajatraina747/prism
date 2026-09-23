import { describe, it, expect } from 'vitest';
import { findDuplicate, findMediaDuplicate } from '../dedupe';
import type { DownloadItem, HistoryItem } from '@/types/models';

const meta = (url: string, mediaKey?: string) => ({
  title: 't', duration: 0, thumbnail: '', formats: [], source: { url, domain: '', addedAt: '' }, ...(mediaKey ? { mediaKey } : {}),
});
const queued = (url: string, mediaKey?: string, status: DownloadItem['status'] = 'queued') =>
  ({ id: url, metadata: meta(url, mediaKey), status } as unknown as DownloadItem);
const done = (url: string, mediaKey?: string) =>
  ({ id: url, metadata: meta(url, mediaKey), status: 'completed' } as unknown as HistoryItem);

describe('findDuplicate (by URL)', () => {
  it('knows a YouTube video however it is linked', () => {
    expect(findDuplicate('https://youtu.be/abc', [queued('https://www.youtube.com/watch?v=abc')], [])).toBe('queue');
  });
  it('ignores finished queue rows', () => {
    expect(findDuplicate('https://youtu.be/abc', [queued('https://www.youtube.com/watch?v=abc', undefined, 'completed')], [])).toBeNull();
  });
});

// The 2.1 extension: sites URL normalisation doesn't know.
describe('findMediaDuplicate (by extractor + id)', () => {
  it('catches the same video behind two different URLs', () => {
    const q = [queued('https://vimeo.com/76979871', 'vimeo:76979871')];
    expect(findMediaDuplicate('vimeo:76979871', q, [])).toBe('queue');
    expect(findMediaDuplicate('vimeo:76979871', [], [done('https://player.vimeo.com/video/76979871', 'vimeo:76979871')])).toBe('completed');
  });
  it('says nothing without a key, or for another video', () => {
    expect(findMediaDuplicate(undefined, [queued('x', 'vimeo:1')], [])).toBeNull();
    expect(findMediaDuplicate('vimeo:2', [queued('x', 'vimeo:1')], [])).toBeNull();
    expect(findMediaDuplicate('vimeo:1', [queued('x')], [])).toBeNull();
  });
});
