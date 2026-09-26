// Problems with Prism's own data files (see json-store.ts), handed to the UI.
//
// Loading happens before anything renders, so problems found then are held
// until the app shell subscribes. A failed save is reported once per file per
// launch: the next save retries it, and a toast on every keystroke would help
// nobody.

import type { StoreProblem } from './json-store';

let listener: ((p: StoreProblem) => void) | null = null;
const pending: StoreProblem[] = [];
const saveFailuresTold = new Set<string>();

export function reportStoreProblem(problem: StoreProblem): void {
  if (problem.kind === 'save-failed') {
    if (saveFailuresTold.has(problem.file)) return;
    saveFailuresTold.add(problem.file);
  }
  if (listener) listener(problem);
  else pending.push(problem);
}

export function onStoreProblem(cb: (p: StoreProblem) => void): () => void {
  listener = cb;
  pending.splice(0).forEach(cb);
  return () => {
    if (listener === cb) listener = null;
  };
}

const LABELS: Record<string, string> = {
  'queue.json': 'your transfers',
  'history.json': 'your Library',
  'settings.json': 'your settings',
  'subscriptions.json': 'your subscriptions',
  'stats.json': 'your statistics',
};

/** What to tell the user, as a toast title and description. */
export function describeStoreProblem(p: StoreProblem): { title: string; description: string } {
  const what = LABELS[p.file] ?? p.file;
  const kept = 'keptAs' in p && p.keptAs ? ` The damaged file was kept as ${p.keptAs}.` : '';
  switch (p.kind) {
    case 'recovered':
      return { title: `Restored ${what} from a backup`, description: `The saved copy was damaged, so Prism loaded the one before it.${kept}` };
    case 'reset':
      return { title: `Couldn't read ${what}`, description: `The saved copy was damaged and there was no backup, so Prism started it fresh.${kept}` };
    case 'save-failed':
      return { title: `Couldn't save ${what}`, description: 'Check free disk space. Recent changes may not survive a restart until a save succeeds.' };
  }
}
