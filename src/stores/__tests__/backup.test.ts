import { describe, it, expect } from 'vitest';
import { buildBackup, parseBackup, mergeSettings, mergeHistory, mergeSubscriptions, describeImport, BACKUP_VERSION } from '../backup';
import { DEFAULT_PREFERENCES, type AppPreferences, type HistoryItem, type Subscription } from '@/types/models';

function item(id: string, completedAt = '2026-09-01T00:00:00.000Z'): HistoryItem {
  return {
    id,
    metadata: { title: id, duration: 0, thumbnail: '', formats: [], source: { url: `https://x/${id}`, domain: 'x', addedAt: '' } },
    settings: { format: null, destination: '/dl', filename: id, retryCount: 0, startImmediately: true },
    status: 'completed',
    completedAt,
    fileSize: 1,
  };
}

function sub(id: string, url: string): Subscription {
  return { id, url, title: id, addedAt: '', enabled: true, audioOnly: false, seenUrls: [] };
}

const settings: AppPreferences = {
  ...DEFAULT_PREFERENCES,
  theme: 'light',
  defaultSaveFolder: '/Volumes/Old Mac/Downloads',
  moveCompletedTo: '/Volumes/Old Mac/Done',
  watchFolders: [{ path: '/Users/old/Downloads', enabled: true }],
};

describe('backup round trip', () => {
  it('carries settings, Library and subscriptions', () => {
    const backup = buildBackup({ settings, history: [item('a')], subscriptions: [sub('s1', 'https://feed')], appVersion: '2.1.0', now: new Date(0) });
    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.backup.settings.theme).toBe('light');
    expect(parsed.backup.history.map(h => h.id)).toEqual(['a']);
    expect(parsed.backup.subscriptions.map(s => s.url)).toEqual(['https://feed']);
  });

  it("never carries this machine's folders", () => {
    const backup = buildBackup({ settings, history: [], subscriptions: [], appVersion: '2.1.0' });
    const text = JSON.stringify(backup);
    expect(text).not.toContain('/Volumes/Old Mac');
    expect(text).not.toContain('/Users/old/Downloads');
  });
});

describe('parseBackup', () => {
  it('refuses what is not a Prism backup', () => {
    expect(parseBackup('not json').ok).toBe(false);
    expect(parseBackup('{"format":"something-else"}').ok).toBe(false);
  });

  it('refuses a backup from a newer Prism', () => {
    const parsed = parseBackup(JSON.stringify({ format: 'prism-export', version: BACKUP_VERSION + 1 }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/newer Prism/);
  });

  it('drops malformed entries instead of failing the whole import', () => {
    const parsed = parseBackup(JSON.stringify({
      format: 'prism-export', version: 1,
      history: [item('good'), { id: 'no-metadata' }, 42],
      subscriptions: [sub('s', 'https://f'), { id: 'no-url' }],
    }));
    expect(parsed.ok && parsed.backup.history.map(h => h.id)).toEqual(['good']);
    expect(parsed.ok && parsed.backup.subscriptions.map(s => s.id)).toEqual(['s']);
  });
});

describe('merging', () => {
  it("keeps this machine's folders whatever the backup says", () => {
    const current: AppPreferences = { ...DEFAULT_PREFERENCES, defaultSaveFolder: '~/Downloads/Prism', watchFolders: [] };
    const merged = mergeSettings(current, { theme: 'light', defaultSaveFolder: '/elsewhere', watchFolders: [{ path: '/x', enabled: true }] });
    expect(merged.theme).toBe('light');
    expect(merged.defaultSaveFolder).toBe('~/Downloads/Prism');
    expect(merged.watchFolders).toEqual([]);
  });

  it('merges the Library by id, newest record winning, newest first', () => {
    const merged = mergeHistory(
      [item('a', '2026-09-01T00:00:00.000Z'), item('b', '2026-09-02T00:00:00.000Z')],
      [item('a', '2026-09-05T00:00:00.000Z'), item('c', '2026-09-03T00:00:00.000Z')],
    );
    expect(merged.map(h => `${h.id}@${h.completedAt.slice(8, 10)}`)).toEqual(['a@05', 'c@03', 'b@02']);
  });

  // The Library lives in the database now and has no cap: an import keeps
  // everything, newest first.
  it('keeps the whole Library, newest first', () => {
    const many = Array.from({ length: 2500 }, (_, i) => item(`i${i}`, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()));
    const merged = mergeHistory([], many);
    expect(merged).toHaveLength(2500);
    expect(merged[0].id).toBe('i2499');
  });

  it("adds new feeds and keeps this machine's copy of ones it already has", () => {
    const mine = { ...sub('s1', 'https://feed'), seenUrls: ['https://v/1'] };
    const merged = mergeSubscriptions([mine], [sub('other-id', 'https://feed'), sub('s2', 'https://new')]);
    expect(merged.map(s => s.url)).toEqual(['https://feed', 'https://new']);
    expect(merged[0].seenUrls).toEqual(['https://v/1']);
  });

  it('describes what an import adds', () => {
    const backup = buildBackup({ settings, history: [item('a'), item('b')], subscriptions: [sub('s', 'https://f')], appVersion: '2.1.0' });
    expect(describeImport(backup, { history: [item('a')], subscriptions: [] })).toEqual({ newLibraryEntries: 1, newSubscriptions: 1, settings: true });
  });
});
