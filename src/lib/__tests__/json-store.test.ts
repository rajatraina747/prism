import { describe, it, expect } from 'vitest';
import { loadJson, saveJson, backupName, type JsonFs, type StoreProblem } from '../json-store';

function memoryFs(initial: Record<string, string> = {}): JsonFs & { disk: Map<string, string> } {
  const disk = new Map(Object.entries(initial));
  return {
    disk,
    async read(file) {
      const text = disk.get(file);
      if (text === undefined) throw new Error('No such file');
      return text;
    },
    async write(file, text) { disk.set(file, text); },
    async rename(from, to) {
      const text = disk.get(from);
      if (text === undefined) throw new Error('No such file');
      disk.delete(from);
      disk.set(to, text);
    },
  };
}

const NOW = () => new Date('2026-09-26T10:00:00.000Z');

// Regression (REVIEW 2026-09-26): a damaged file used to load as [] and be
// overwritten by the next save.
describe('json-store', () => {
  it('loads a good file untouched', async () => {
    const fs = memoryFs({ 'history.json': '[1,2]' });
    const problems: StoreProblem[] = [];
    expect(await loadJson(fs, 'history.json', [], p => problems.push(p), NOW)).toEqual([1, 2]);
    expect(problems).toEqual([]);
  });

  it('sets a damaged file aside and loads the backup', async () => {
    const fs = memoryFs({ 'history.json': '[1,2', 'history.bak.json': '[1]' });
    const problems: StoreProblem[] = [];
    expect(await loadJson(fs, 'history.json', [], p => problems.push(p), NOW)).toEqual([1]);
    const keptAs = 'history.corrupt-2026-09-26T10-00-00-000Z.json';
    expect(fs.disk.get(keptAs)).toBe('[1,2');
    expect(fs.disk.has('history.json')).toBe(false);
    expect(problems).toEqual([{ kind: 'recovered', file: 'history.json', keptAs }]);
  });

  it('reports a reset when there is no usable backup, keeping the damaged copy', async () => {
    const fs = memoryFs({ 'queue.json': '{oops' });
    const problems: StoreProblem[] = [];
    expect(await loadJson(fs, 'queue.json', [], p => problems.push(p), NOW)).toEqual([]);
    expect(problems[0]).toMatchObject({ kind: 'reset', file: 'queue.json' });
    expect([...fs.disk.values()]).toContain('{oops');
  });

  it('quietly uses the backup when a save was cut between its renames', async () => {
    const fs = memoryFs({ 'settings.json.tmp': '{"a":2}', 'settings.bak.json': '{"a":1}' });
    const problems: StoreProblem[] = [];
    expect(await loadJson(fs, 'settings.json', null, p => problems.push(p), NOW)).toEqual({ a: 1 });
    expect(problems).toEqual([]);
  });

  it('a missing file with no backup is just the first launch', async () => {
    const problems: StoreProblem[] = [];
    expect(await loadJson(memoryFs(), 'stats.json', null, p => problems.push(p), NOW)).toBeNull();
    expect(problems).toEqual([]);
  });

  it('keeps the previous version as the backup on every save', async () => {
    const fs = memoryFs();
    await saveJson(fs, 'history.json', '[1]');
    expect(fs.disk.get('history.json')).toBe('[1]');
    expect(fs.disk.has(backupName('history.json'))).toBe(false);
    await saveJson(fs, 'history.json', '[1,2]');
    expect(fs.disk.get('history.json')).toBe('[1,2]');
    expect(fs.disk.get('history.bak.json')).toBe('[1]');
    expect(fs.disk.has('history.json.tmp')).toBe(false);
  });

  it('a save after a damaged load never touches the damaged copy', async () => {
    const fs = memoryFs({ 'history.json': 'garbage', 'history.bak.json': '[1]' });
    await loadJson(fs, 'history.json', [], () => {}, NOW);
    await saveJson(fs, 'history.json', '[1,3]');
    expect(fs.disk.get('history.corrupt-2026-09-26T10-00-00-000Z.json')).toBe('garbage');
    expect(fs.disk.get('history.json')).toBe('[1,3]');
  });
});
