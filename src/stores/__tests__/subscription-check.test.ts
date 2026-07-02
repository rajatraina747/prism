import { describe, it, expect } from 'vitest';
import { diffFeed, entryToDownloadItem } from '../subscription-check';
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
    expect(item.settings.filename).toBe('My_Video');
  });

  it('omits audioOnly and speedLimit when unset', () => {
    const item = entryToDownloadItem(entry('https://y/1'), makeSub(), { ...prefs, bandwidthLimit: 0 });
    expect(item.settings.audioOnly).toBeUndefined();
    expect(item.settings.speedLimit).toBeUndefined();
  });

  it('falls back to a safe filename for symbol-only titles', () => {
    const item = entryToDownloadItem(entry('https://y/1', '!!!'), makeSub(), prefs);
    expect(item.settings.filename).toBe('video');
  });
});
