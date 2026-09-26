import { describe, it, expect } from 'vitest';
import { diffFeed, entryToDownloadItem, entryMatches, likelyFeedType, feedEntryAllowed, sameSiteAsSubscription, feedShowsNothingNew, youtubeVideoId, FULL_CHECK_EVERY_MS } from '../subscription-check';
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
    // Stored as a plain name; `%` is escaped only where yt-dlp's -o is built.
    expect(tricky.settings.filename).toBe('a-b-c %(ext)s');
  });

  it('falls back to a safe filename for empty titles', () => {
    const item = entryToDownloadItem(entry('https://y/1', '  '), makeSub(), prefs);
    expect(item.settings.filename).toBe('video');
  });

  it('routes an enclosure to the engine that can fetch it', () => {
    const magnet = entryToDownloadItem(entry('magnet:?xt=urn:btih:abc123'), makeSub(), prefs);
    expect(magnet.kind).toBe('torrent');
    const file = entryToDownloadItem(entry('https://ex.com/ep1.zip'), makeSub(), prefs);
    expect(file.kind).toBe('direct');
    // A normal channel entry is still a yt-dlp page, exactly as before.
    const page = entryToDownloadItem(entry('https://youtube.com/watch?v=abc'), makeSub(), prefs);
    expect(page.kind).toBe('http');
  });
});

describe('likelyFeedType', () => {
  it('spots the usual feed URLs', () => {
    expect(likelyFeedType('https://example.com/feed')).toBe('rss');
    expect(likelyFeedType('https://example.com/podcast.xml')).toBe('rss');
    expect(likelyFeedType('https://example.com/index.rss')).toBe('rss');
    expect(likelyFeedType('https://example.com/blog/atom')).toBe('rss');
    // YouTube's own RSS endpoint, which is a feed even though the host is one
    // yt-dlp would otherwise handle.
    expect(likelyFeedType('https://youtube.com/feeds/videos.xml?channel_id=X')).toBe('rss');
  });

  it('treats channel and playlist URLs as channels', () => {
    expect(likelyFeedType('https://www.youtube.com/@someone')).toBe('channel');
    expect(likelyFeedType('https://www.youtube.com/playlist?list=PL123')).toBe('channel');
  });

  it('does not match a word that merely starts with feed', () => {
    // The guess is cheap to get wrong, but /feedback is a page, not a feed.
    expect(likelyFeedType('https://example.com/feedback')).toBe('channel');
  });

  it('ignores the query string when guessing', () => {
    expect(likelyFeedType('https://example.com/feed?after=2020')).toBe('rss');
  });
});

// Regression (REVIEW 2026-09-26 M1): a feed polls unattended, so its links
// must not become logged-in requests to other sites, or requests into the
// user's own network.
describe('feed entry safety', () => {
  const prefs: AppPreferences = { ...DEFAULT_PREFERENCES, defaultSaveFolder: '/dl' };

  it("gives the browser's cookies only to entries on the subscription's own site", () => {
    const sub = makeSub({ url: 'https://www.youtube.com/@channel' });
    const own = entryToDownloadItem(entry('https://www.youtube.com/watch?v=abc'), sub, prefs);
    expect(own.settings.noCookies).toBeUndefined();
    const mobile = entryToDownloadItem(entry('https://m.youtube.com/watch?v=abc'), sub, prefs);
    expect(mobile.settings.noCookies).toBeUndefined();
    const elsewhere = entryToDownloadItem(entry('https://bank.example.com/transfer?to=x'), sub, prefs);
    expect(elsewhere.settings.noCookies).toBe(true);
  });

  it('treats a subdomain of the subscribed site as the same site, and not the reverse', () => {
    expect(sameSiteAsSubscription('https://media.example.com/ep1.mp3', 'https://example.com/feed.xml')).toBe(true);
    expect(sameSiteAsSubscription('https://example.com/ep1.mp3', 'https://feeds.example.com/rss')).toBe(false);
    expect(sameSiteAsSubscription('https://notexample.com/x', 'https://example.com/rss')).toBe(false);
  });

  it('accepts ordinary internet links and magnets', () => {
    expect(feedEntryAllowed('https://www.youtube.com/watch?v=abc')).toBe(true);
    expect(feedEntryAllowed('http://example.org/ep1.mp3')).toBe(true);
    expect(feedEntryAllowed('https://93.184.216.34/file.mp4')).toBe(true);
    expect(feedEntryAllowed('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567')).toBe(true);
  });

  it('refuses local files, other schemes and addresses inside the network', () => {
    for (const url of [
      'file:///Users/me/secret.torrent',
      '/Users/me/show.torrent',
      'ftp://example.com/x',
      'http://localhost:8080/admin',
      'http://router/reboot',
      'http://printer.local/config',
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://10.0.0.1/',
      'http://172.20.1.1/',
      'http://192.168.1.1/reboot',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'not a url',
    ]) {
      expect(feedEntryAllowed(url), url).toBe(false);
    }
  });
});

// Regression (REVIEW 2026-09-26): a premiere was queued, failed, and marked
// seen, so it was never downloaded once it had aired.
describe('premieres and live streams', () => {
  const entry = (url: string, liveStatus?: string): PlaylistEntry => ({ url, title: url, duration: 0, thumbnail: '', liveStatus });

  it('are neither queued nor marked seen until they have aired', () => {
    const sub = makeSub({ seenUrls: [] });
    const first = diffFeed(sub, [entry('https://www.youtube.com/watch?v=up', 'is_upcoming'), entry('https://www.youtube.com/watch?v=old')]);
    expect(first.newEntries.map(e => e.url)).toEqual(['https://www.youtube.com/watch?v=old']);
    expect(first.seenUrls).not.toContain('https://www.youtube.com/watch?v=up');
    expect(first.pendingUrls).toEqual(['https://www.youtube.com/watch?v=up']);

    const aired = diffFeed({ ...sub, seenUrls: first.seenUrls }, [entry('https://www.youtube.com/watch?v=up', 'was_live'), entry('https://www.youtube.com/watch?v=old')]);
    expect(aired.newEntries.map(e => e.url)).toEqual(['https://www.youtube.com/watch?v=up']);
    expect(aired.pendingUrls).toEqual([]);
  });
});

describe('the RSS shortcut', () => {
  const now = new Date('2026-09-26T12:00:00Z');
  const recent = new Date(now.getTime() - 60_000).toISOString();
  const rss = (ids: string[]): PlaylistEntry[] => ids.map(id => ({ url: `https://www.youtube.com/shorts/${id}`, title: id, duration: 0, thumbnail: '' }));

  it('reads video ids from every YouTube URL shape', () => {
    expect(youtubeVideoId('https://www.youtube.com/watch?v=abc_1')).toBe('abc_1');
    expect(youtubeVideoId('https://www.youtube.com/shorts/xyz-2')).toBe('xyz-2');
    expect(youtubeVideoId('https://youtu.be/q3')).toBe('q3');
    // As YouTube's RSS feed lists each entry (media:content).
    expect(youtubeVideoId('https://www.youtube.com/v/wBA83zXaYcc?version=3')).toBe('wBA83zXaYcc');
    expect(youtubeVideoId('https://vimeo.com/1')).toBeNull();
  });

  it('skips the full check only when nothing is new, recently checked, and nothing is waiting', () => {
    const sub = makeSub({ feedIds: ['a', 'b'], lastFullCheckAt: recent });
    expect(feedShowsNothingNew(sub, rss(['a', 'b']), now)).toBe(true);
    expect(feedShowsNothingNew(sub, rss(['c', 'a']), now)).toBe(false);
    expect(feedShowsNothingNew({ ...sub, pendingUrls: ['x'] }, rss(['a']), now)).toBe(false);
    const stale = new Date(now.getTime() - FULL_CHECK_EVERY_MS).toISOString();
    expect(feedShowsNothingNew({ ...sub, lastFullCheckAt: stale }, rss(['a']), now)).toBe(false);
    expect(feedShowsNothingNew(makeSub({}), rss(['a']), now)).toBe(false);
  });
});
