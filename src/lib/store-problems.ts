// Problems with Prism's own data files (see json-store.ts), handed to the UI.
//
// Loading happens before anything renders, so problems found then are held
// until the app shell subscribes. A failed save is reported once per file per
// launch: the next save retries it, and a toast on every keystroke would help
// nobody.

import type { StoreProblem } from './json-store';
import { t } from '@/i18n';

let listener: ((p: StoreProblem) => void) | null = null;
const pending: StoreProblem[] = [];
const saveFailuresTold = new Set<string>();
// Where problems are also recorded (the desktop app's log file); the web demo
// has none.
let logger: ((p: StoreProblem) => void) | null = null;

export function setStoreProblemLogger(log: (p: StoreProblem) => void): void {
  logger = log;
}

export function reportStoreProblem(problem: StoreProblem): void {
  if (problem.kind === 'save-failed') {
    if (saveFailuresTold.has(problem.file)) return;
    saveFailuresTold.add(problem.file);
  }
  try { logger?.(problem); } catch { /* the toast still matters */ }
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
  'queue.json': t('notices.store.files.queue'),
  'history.json': t('notices.store.files.history'),
  'settings.json': t('notices.store.files.settings'),
  'subscriptions.json': t('notices.store.files.subscriptions'),
  'stats.json': t('notices.store.files.stats'),
  'prism.db': t('notices.store.files.db'),
};

/** What to tell the user, as a toast title and description. */
export function describeStoreProblem(p: StoreProblem): { title: string; description: string } {
  const what = LABELS[p.file] ?? p.file;
  const kept = 'keptAs' in p && p.keptAs ? t('notices.store.kept', { file: p.keptAs }) : '';
  switch (p.kind) {
    case 'recovered':
      return { title: t('notices.store.recoveredTitle', { what }), description: t('notices.store.recovered') + kept };
    case 'rebuilt':
      return { title: t('notices.store.rebuiltTitle', { what }), description: t('notices.store.rebuilt') + kept };
    case 'reset':
      return { title: t('notices.store.resetTitle', { what }), description: t('notices.store.reset') + kept };
    case 'save-failed':
      return { title: t('notices.store.saveFailedTitle', { what }), description: t('notices.store.saveFailed') };
  }
}
