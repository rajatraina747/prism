/**
 * Translations (2.7). Every string the UI shows lives in `src/locales/<lang>/`,
 * one JSON file per area (`add.json` → keys `add.*`). Components use
 * `useTranslation()`; code outside React (stores, services) imports `t` from
 * here. The Rust side reads the same `en` files for menu and notification text
 * (see `src-tauri/src/i18n.rs`), so a key used there must not be renamed
 * without updating it.
 *
 * English only for now. In development, `localStorage.prism_locale = "pseudo"`
 * switches to a pseudo-locale (accented, bracketed, ~35% longer) that shows
 * any string still hard-coded and any layout that clips longer languages.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

type Tree = { [key: string]: string | Tree };

function load(files: Record<string, unknown>): Tree {
  const tree: Tree = {};
  for (const [path, json] of Object.entries(files)) {
    const area = path.split('/').pop()!.replace(/\.json$/, '');
    tree[area] = json as Tree;
  }
  return tree;
}

const en = load(import.meta.glob('./locales/en/*.json', { eager: true, import: 'default' }));

const ACCENTS: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ď', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ',
  k: 'ķ', l: 'ĺ', m: 'ɱ', n: 'ñ', o: 'ó', p: 'þ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ú',
  w: 'ŵ', y: 'ý', z: 'ž', A: 'Á', C: 'Ç', D: 'Ď', E: 'É', I: 'Í', N: 'Ñ', O: 'Ó',
  S: 'Š', U: 'Ú', Y: 'Ý',
};

/** Accent and lengthen a string, leaving `{{placeholders}}` and `<tags>` intact. */
export function pseudo(s: string): string {
  const out = s
    .split(/(\{\{[^}]+\}\}|<[^>]+>)/)
    .map((part, i) => (i % 2 ? part : part.replace(/[A-Za-z]/g, (c) => ACCENTS[c] ?? c)))
    .join('');
  const pad = '~'.repeat(Math.ceil(s.length * 0.35));
  return `⟦${out}${pad}⟧`;
}

function mapTree(tree: Tree, f: (s: string) => string): Tree {
  const out: Tree = {};
  for (const [k, v] of Object.entries(tree)) out[k] = typeof v === 'string' ? f(v) : mapTree(v, f);
  return out;
}

function wantedLanguage(): string {
  if (!import.meta.env.DEV) return 'en';
  try {
    return localStorage.getItem('prism_locale') === 'pseudo' ? 'pseudo' : 'en';
  } catch {
    return 'en';
  }
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ...(import.meta.env.DEV ? { pseudo: { translation: mapTree(en, pseudo) } } : {}),
  },
  lng: wantedLanguage(),
  fallbackLng: 'en',
  // React escapes already; i18next escaping would double-encode `&`.
  interpolation: { escapeValue: false },
  returnNull: false,
  // Resources are bundled, so init is synchronous: no flash of keys.
  initAsync: false,
});

export const t = i18n.t.bind(i18n);
export default i18n;

/** The active language as a BCP 47 tag for `Intl` (pseudo formats as English). */
export function locale(): string {
  return i18n.language === 'pseudo' ? 'en' : i18n.language || 'en';
}
