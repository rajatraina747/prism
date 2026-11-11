import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';

// Every literal key passed to t() must exist in the English catalog, so a typo
// fails here instead of showing "queue.sesion.port" to a user. Plural keys
// (`_one`/`_other`) count as present when their base is used with `count`.
const sources = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/**/__tests__/**'], {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const KEY_RE = /\bt\(\s*['"`]([a-zA-Z][\w-]*(?:\.[\w-]+)+)['"`]/g;

describe('i18n keys', () => {
  it('every t() key used in the source exists in en', () => {
    const missing: string[] = [];
    let seen = 0;
    for (const [file, text] of Object.entries(sources)) {
      for (const m of text.matchAll(KEY_RE)) {
        const key = m[1];
        if (key.includes('${')) continue;
        seen++;
        const ok = i18n.exists(key) || i18n.exists(`${key}_other`);
        if (!ok) missing.push(`${file}: ${key}`);
      }
    }
    expect(seen).toBeGreaterThan(20); // the scan itself works
    expect(missing).toEqual([]);
  });
});
