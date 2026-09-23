import { describe, it, expect } from 'vitest';
import { sortHistory, gridColumns, trashTarget, baseName } from '../library';
import type { HistoryItem } from '@/types/models';

function item(partial: {
  id: string;
  title?: string;
  completedAt?: string;
  fileSize?: number;
}): HistoryItem {
  return {
    id: partial.id,
    metadata: {
      title: partial.title ?? partial.id,
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
    status: 'completed',
    completedAt: partial.completedAt ?? '2026-01-01T00:00:00.000Z',
    fileSize: partial.fileSize ?? 0,
  };
}

const ids = (items: HistoryItem[]) => items.map(i => i.id);

describe('sortHistory', () => {
  const a = item({ id: 'a', title: 'Banana', completedAt: '2026-03-01T00:00:00.000Z', fileSize: 100 });
  const b = item({ id: 'b', title: 'apple', completedAt: '2026-01-01T00:00:00.000Z', fileSize: 300 });
  const c = item({ id: 'c', title: 'Episode 10', completedAt: '2026-02-01T00:00:00.000Z', fileSize: 200 });

  it('puts the most recent first by default', () => {
    expect(ids(sortHistory([b, c, a], 'newest'))).toEqual(['a', 'c', 'b']);
  });

  it('reverses for oldest', () => {
    expect(ids(sortHistory([a, b, c], 'oldest'))).toEqual(['b', 'c', 'a']);
  });

  it('sorts by title, ignoring case', () => {
    // 'apple' before 'Banana': case must not push lowercase to the end.
    expect(ids(sortHistory([a, b], 'title'))).toEqual(['b', 'a']);
  });

  it('sorts titles with numbers the way a person reads them', () => {
    const two = item({ id: 'two', title: 'Episode 2' });
    const ten = item({ id: 'ten', title: 'Episode 10' });
    expect(ids(sortHistory([ten, two], 'title'))).toEqual(['two', 'ten']);
  });

  it('sorts by size, largest first, treating a missing size as zero', () => {
    const none = item({ id: 'none', completedAt: '2026-04-01T00:00:00.000Z' });
    expect(ids(sortHistory([a, none, b, c], 'size'))).toEqual(['b', 'c', 'a', 'none']);
  });

  it('breaks ties by recency rather than leaving them to chance', () => {
    const older = item({ id: 'older', title: 'Same', completedAt: '2026-01-01T00:00:00.000Z' });
    const newer = item({ id: 'newer', title: 'Same', completedAt: '2026-05-01T00:00:00.000Z' });
    expect(ids(sortHistory([older, newer], 'title'))).toEqual(['newer', 'older']);
  });

  it('survives an unparseable completion time', () => {
    // A NaN comparator doesn't misplace one row, it scrambles the whole list.
    const broken = { ...item({ id: 'broken' }), completedAt: 'not a date' };
    const sorted = sortHistory([a, broken, b], 'newest');
    expect(sorted).toHaveLength(3);
    expect(ids(sorted)).toContain('broken');
    expect(ids(sorted).slice(0, 2)).toEqual(['a', 'b']);
  });

  it('does not sort the caller\'s array in place', () => {
    const original = [b, a, c];
    sortHistory(original, 'newest');
    expect(ids(original)).toEqual(['b', 'a', 'c']);
  });
});

describe('gridColumns', () => {
  it('gives a phone-width grid a single column', () => {
    expect(gridColumns(390)).toBe(1);
    expect(gridColumns(0)).toBe(1);
    expect(gridColumns(Number.NaN)).toBe(1);
  });

  it('adds columns as the window widens, within a sane cap', () => {
    expect(gridColumns(720)).toBe(3);
    expect(gridColumns(1280)).toBe(5);
    expect(gridColumns(4000)).toBe(6);
  });
});

describe('trashTarget', () => {
  const dest = '/Users/r/Downloads/Prism';
  const row = (extra: Partial<HistoryItem>): HistoryItem => {
    const base = item({ id: 'x' });
    return { ...base, settings: { ...base.settings, destination: dest }, ...extra };
  };

  it('takes a downloaded file', () => {
    expect(trashTarget(row({ filePath: `${dest}/clip.mp4` }))).toEqual({ path: `${dest}/clip.mp4`, folder: false });
  });

  // Regression (REVIEW 2026-09-23 B-3): a single-file torrent recorded the
  // shared destination as its path, and trashing the row trashed everything.
  it('never takes the folder a download was saved into', () => {
    expect(trashTarget(row({ filePath: dest, outputFolder: dest, files: [{ name: 'a.iso', size: 1 }] }))).toBeUndefined();
    expect(trashTarget(row({ outputFolder: dest, files: [{ name: 'a.iso', size: 1 }] }))).toBeUndefined();
    expect(trashTarget(row({ filePath: `${dest}/` }))).toBeUndefined();
  });

  it("takes a multi-file torrent's own folder, and says it is one", () => {
    const own = `${dest}/Pack`;
    const files = [{ name: 'a', size: 1 }, { name: 'b', size: 1 }];
    expect(trashTarget(row({ outputFolder: own, files }))).toEqual({ path: own, folder: true });
    expect(trashTarget(row({ filePath: own, outputFolder: own, files }))).toEqual({ path: own, folder: true });
  });

  it('leaves a single-file output folder alone even when it is not the destination', () => {
    expect(trashTarget(row({ outputFolder: '/Volumes/Media', files: [{ name: 'a', size: 1 }] }))).toBeUndefined();
  });

  it('has nothing to take for a row with no path', () => {
    expect(trashTarget(row({}))).toBeUndefined();
  });
});

describe('baseName', () => {
  it('names the last component', () => {
    expect(baseName('/a/b/Pack/')).toBe('Pack');
    expect(baseName('C:\\Media\\Pack')).toBe('Pack');
  });
});
