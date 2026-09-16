import { describe, it, expect } from 'vitest';
import { diffFeed, entryToDownloadItem, entryMatches } from '../subscription-check';
import type { Subscription, PlaylistEntry, AppPreferences } from '@/types/models';
import { DEFAULT_PREFERENCES } from '@/types/models';

function makeSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 's1',
    url: 'https://www.youtube.com/@channel',
    title: 'Test Channel',
    addedAt: '2026-07-01T00:00:00Z',
    enabled: true,
    audioOnly: false,
    seenUrls: [],
    ...overrides,
  };
}

function entry(url: string, title = 'Video'): PlaylistEntry {
  return { url, title, duration: 60, thumbnail: '' };
}

describe('diffFeed', () => {
  it('reports everything new for an empty seen set', () => {
    const feed = [entry('https://y/1'), entry('https://y/2')];
    const { newEntries, seenUrls } = diffFeed(makeSub(), feed);
    expect(newEntries).toHaveLength(2);
    expect(seenUrls).toEqual(['https://y/1', 'https://y/2']);
  });

  it('reports only unseen entries', () => {
    const sub = makeSub({ seenUrls: ['https://y/2', 'https://y/3'] });
    const feed = [entry('https://y/1'), entry('https://y/2')];
    const { newEntries } = diffFeed(sub, feed);
    expect(newEntries.map(e => e.url)).toEqual(['https://y/1']);
  });

  it('keeps previously-seen urls that dropped out of the feed window', () => {
    // A video that scrolled past the feed's page size must stay "seen",
    // or it would re-download when the feed shrinks.
    const sub = makeSub({ seenUrls: ['https://y/old'] });
    const feed = [entry('https://y/new')];
    const { seenUrls } = diffFeed(sub, feed);
    expect(seenUrls).toEqual(['https://y/new', 'https://y/old']);
  });

  it('caps the seen set', () => {
    const seen = Array.from({ length: 1500 }, (_, i) => `https://y/old-${i}`);
    const { seenUrls } = diffFeed(makeSub({ seenUrls: seen }), [entry('https://y/new')]);
    expect(seenUrls).toHaveLength(1000);
    expect(seenUrls[0]).toBe('https://y/new');
  });

  it('returns no new entries when nothing changed', () => {
    const feed = [entry('https://y/1')];
    const sub = makeSub({ seenUrls: ['https://y/1'] });
    expect(diffFeed(sub, feed).newEntries).toHaveLength(0);
  });
});

describe('entryMatches', () => {
  it('takes everything when no rules are set — what a subscription has always meant', () => {
    expect(entryMatches(makeSub(), entry('https://y/1', 'Anything'))).toBe(true);
    expect(entryMatches(makeSub({ includeKeywords: [], excludeKeywords: [] }), entry('https://y/1'))).toBe(true);
  });

  it('keeps only what an include list names', () => {
    const sub = makeSub({ includeKeywords: ['review'] });
    expect(entryMatches(sub, entry('https://y/1', 'Laptop Review 2026'))).toBe(true);
    expect(entryMatches(sub, entry('https://y/2', 'Unboxing'))).toBe(false);
  });

  it('drops what an exclude list names, even when an include also matches', () => {
    const sub = makeSub({ includeKeywords: ['review'], excludeKeywords: ['sponsored'] });
    expect(entryMatches(sub, entry('https://y/1', 'Review — sponsored'))).toBe(false);
    expect(entryMatches(sub, entry('https://y/2', 'Review'))).toBe(true);
  });

  it('excludes without an include list, taking everything else', () => {
    const sub = makeSub({ excludeKeywords: ['shorts'] });
    expect(entryMatches(sub, entry('https://y/shorts/1', 'Clip'))).toBe(false);
    expect(entryMatches(sub, entry('https://y/watch/2', 'Full episode'))).toBe(true);
  });

  it('ignores case and stray whitespace in the rules', () => {
    const sub = makeSub({ includeKeywords: ['  REVIEW  ', ''] });
    expect(entryMatches(sub, entry('https://y/1', 'a review'))).toBe(true);
  });

  it('matches the URL too, not just the title', () => {
    const sub = makeSub({ excludeKeywords: ['/live/'] });
    expect(entryMatches(sub, entry('https://y/live/1', 'Stream'))).toBe(false);
  });
});

describe('diffFeed with rules', () => {
  it('remembers a filtered-out video as seen, so it is never reconsidered', () => {
    const sub = makeSub({ excludeKeywords: ['trailer'] });
    const feed = [entry('https://y/1', 'Trailer'), entry('https://y/2', 'Episode')];
    const { newEntries, seenUrls } = diffFeed(sub, feed);
    expect(newEntries.map(e => e.url)).toEqual(['https://y/2']);
    // The rejected one is still seen — otherwise loosening the rules later
    // would download the whole back catalogue at once.
    expect(seenUrls).toContain('https://y/1');
  });
});

describe('entryToDownloadItem', () => {
  const prefs: AppPreferences = { ...DEFAULT_PREFERENCES, defaultSaveFolder: '/dl', bandwidthLimit: 2 };

  it('builds a queued item with subscription and preference settings applied', () => {
    const item = entryToDownloadItem(entry('https://y/1', 'My Video!'), makeSub({ audioOnly: true }), prefs);
    expect(item.status).toBe('queued');
    expect(item.metadata.source.url).toBe('https://y/1');
    expect(item.metadata.uploader).toBe('Test Channel');
    expect(item.settings).toMatchObject({
      format: null,
      destination: '/dl',
      audioOnly: true,
      speedLimit: 2 * 1024 * 1024,
    });
    expect(item.settings.filename).toBe('My Video!');
  });

  it("files the download under the feed's category, and leaves it unset otherwise", () => {
    const filed = entryToDownloadItem(entry('https://y/1'), makeSub({ categoryId: 'music' }), prefs);
    // addToQueue only auto-sorts when no category is already set, so this
    // wins over the site and engine rules.
    expect(filed.settings.categoryId).toBe('music');
    expect(entryToDownloadItem(entry('https://y/2'), makeSub(), prefs).settings.categoryId).toBeUndefined();
  });

  it('omits audioOnly and speedLimit when unset', () => {
    const item = entryToDownloadItem(entry('https://y/1'), makeSub(), { ...prefs, bandwidthLimit: 0 });
    expect(item.settings.audioOnly).toBeUndefined();
    expect(item.settings.speedLimit).toBeUndefined();
  });

  it('keeps unicode titles and neutralizes path separators', () => {
    const cjk = entryToDownloadItem(entry('https://y/1', '日本語のタイトル'), makeSub(), prefs);
    expect(cjk.settings.filename).toBe('日本語のタイトル');
    const tricky = entryToDownloadItem(entry('https://y/2', 'a/b\\c %(ext)s'), makeSub(), prefs);
    expect(tricky.settings.filename).toBe('a-b-c %%(ext)s');
  });

  it('falls back to a safe filename for empty titles', () => {
    const item = entryToDownloadItem(entry('https://y/1', '  '), makeSub(), prefs);
    expect(item.settings.filename).toBe('video');
  });
});
