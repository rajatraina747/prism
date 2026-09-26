import { describe, it, expect } from 'vitest';
import { reportStoreProblem, onStoreProblem, describeStoreProblem } from '../store-problems';
import type { StoreProblem } from '../json-store';

describe('store problems', () => {
  it('holds problems found before anyone listens, and tells each save failure once', () => {
    reportStoreProblem({ kind: 'recovered', file: 'history.json', keptAs: 'history.corrupt-x.json' });
    const heard: StoreProblem[] = [];
    const stop = onStoreProblem(p => heard.push(p));
    expect(heard).toHaveLength(1);
    reportStoreProblem({ kind: 'save-failed', file: 'queue.json' });
    reportStoreProblem({ kind: 'save-failed', file: 'queue.json' });
    expect(heard).toHaveLength(2);
    stop();
  });

  it('names the file in plain words and says where the damaged copy went', () => {
    const d = describeStoreProblem({ kind: 'recovered', file: 'history.json', keptAs: 'history.corrupt-x.json' });
    expect(d.title).toBe('Restored your Library from a backup');
    expect(d.description).toContain('history.corrupt-x.json');
    expect(describeStoreProblem({ kind: 'reset', file: 'settings.json', keptAs: null }).title).toBe("Couldn't read your settings");
  });
});
