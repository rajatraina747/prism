import { describe, it, expect } from 'vitest';
import { categoryFor, categoryMatches, applyCategory } from '../categories';
import type { DownloadCategory, DownloadItem, DownloadKind } from '@/types/models';

function item(url: string, kind?: DownloadKind): DownloadItem {
  return {
    id: 'x',
    metadata: {
      title: 'A video',
      duration: 0,
      thumbnail: '',
      source: { url, domain: 'example.com', addedAt: '2026-09-16T00:00:00Z' },
      formats: [],
    },
    settings: { format: null, destination: '~/Downloads/Prism', filename: 'A video', retryCount: 0, startImmediately: true },
    status: 'queued',
    progress: 0,
    speed: 0,
    eta: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    retryAttempt: 0,
    ...(kind ? { kind } : {}),
  };
}

function category(over: Partial<DownloadCategory> = {}): DownloadCategory {
  return { id: 'c1', name: 'Music', destination: '', filenameTemplate: '', domains: [], kinds: [], ...over };
}

describe('categoryMatches', () => {
  it('claims a host and its subdomains, but not lookalikes', () => {
    const music = category({ domains: ['youtube.com'] });
    expect(categoryMatches(music, item('https://www.youtube.com/watch?v=abc'))).toBe(true);
    expect(categoryMatches(music, item('https://music.youtube.com/watch?v=abc'))).toBe(true);
    expect(categoryMatches(music, item('https://notyoutube.com/watch?v=abc'))).toBe(false);
    expect(categoryMatches(music, item('https://vimeo.com/123'))).toBe(false);
  });

  it('claims by engine', () => {
    const torrents = category({ kinds: ['torrent'] });
    expect(categoryMatches(torrents, item('magnet:?xt=urn:btih:abc', 'torrent'))).toBe(true);
    expect(categoryMatches(torrents, item('https://example.com/a.iso', 'direct'))).toBe(false);
    // No kind recorded means a yt-dlp download.
    expect(categoryMatches(category({ kinds: ['http'] }), item('https://youtube.com/watch?v=a'))).toBe(true);
  });

  it('needs every rule it states to match', () => {
    const both = category({ domains: ['archive.org'], kinds: ['direct'] });
    expect(categoryMatches(both, item('https://archive.org/x.zip', 'direct'))).toBe(true);
    expect(categoryMatches(both, item('https://archive.org/watch/x'))).toBe(false);
    expect(categoryMatches(both, item('https://example.com/x.zip', 'direct'))).toBe(false);
  });

  it('claims nothing when it states no rules', () => {
    expect(categoryMatches(category(), item('https://youtube.com/watch?v=a'))).toBe(false);
  });
});

describe('categoryFor', () => {
  it('takes the first match, so order is the priority', () => {
    const first = category({ id: 'a', name: 'Anything YouTube', domains: ['youtube.com'] });
    const second = category({ id: 'b', name: 'Music', domains: ['music.youtube.com'] });
    expect(categoryFor([first, second], item('https://music.youtube.com/watch?v=a'))?.id).toBe('a');
    expect(categoryFor([second, first], item('https://music.youtube.com/watch?v=a'))?.id).toBe('b');
    expect(categoryFor([first, second], item('https://vimeo.com/1'))).toBeNull();
  });
});

describe('applyCategory', () => {
  it('takes the destination and template the category sets', () => {
    const music = category({ destination: '~/Music', filenameTemplate: '{uploader}/{title}' });
    const applied = applyCategory(item('https://youtube.com/watch?v=a'), music);
    expect(applied.settings.destination).toBe('~/Music');
    expect(applied.settings.filenameTemplate).toBe('{uploader}/{title}');
    expect(applied.settings.categoryId).toBe('c1');
    expect(applied.settings.categoryName).toBe('Music');
  });

  it('leaves alone what the category leaves blank', () => {
    const bare = category({ name: 'Bare' });
    const applied = applyCategory(item('https://youtube.com/watch?v=a'), bare);
    expect(applied.settings.destination).toBe('~/Downloads/Prism');
    expect(applied.settings.filenameTemplate).toBeUndefined();
    expect(applied.settings.categoryName).toBe('Bare');
  });
});
