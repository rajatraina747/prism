// The app's colour scheme, without a theme library: one class on <html>
// ("dark" or "light"; index.css keys off .light), set from the Theme setting.
// "system" follows the OS and changes with it. Replaces next-themes (2.6),
// whose inline script tripped React 19's warning on every route.

export type ThemePref = 'dark' | 'light' | 'system';
type Resolved = 'dark' | 'light';

const KEY = 'prism-theme';
const listeners = new Set<() => void>();
let pref: ThemePref = 'dark';
let resolved: Resolved = 'dark';

function systemScheme(): Resolved {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function paint() {
  resolved = pref === 'system' ? systemScheme() : pref;
  const root = document.documentElement;
  root.classList.remove('dark', 'light');
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
  listeners.forEach(l => l());
}

/** Apply a Theme setting, and remember it so the next launch paints it
 * before settings have loaded (no dark flash for a light-theme user). */
export function applyTheme(next: ThemePref) {
  pref = next;
  try { localStorage.setItem(KEY, next); } catch { /* private mode: fine */ }
  paint();
}

/** Before the first render: the remembered setting, and follow the OS. */
export function initTheme() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light' || saved === 'system') pref = saved;
  } catch { /* use the default */ }
  paint();
  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (pref === 'system') paint();
    });
  } catch { /* old engines: no live follow */ }
}

export function resolvedTheme(): Resolved {
  return resolved;
}

export function subscribeTheme(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
