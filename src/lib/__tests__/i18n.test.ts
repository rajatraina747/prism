import { describe, expect, it } from 'vitest';
import i18n, { pseudo, t } from '@/i18n';
import { formatBytes, formatEta, formatSpeed } from '@/services/utils';

describe('i18n', () => {
  it('starts in English with the bundled catalog', () => {
    expect(i18n.language).toBe('en');
    expect(t('units.perSecond', { size: '1 MB' })).toBe('1 MB/s');
  });

  it('pseudo-locale keeps placeholders and tags intact', () => {
    const out = pseudo('Saved {{count}} files to <b>Downloads</b>');
    expect(out).toContain('{{count}}');
    expect(out).toContain('<b>');
    expect(out).toContain('</b>');
    expect(out.startsWith('⟦') && out.endsWith('⟧')).toBe(true);
    expect(out).not.toContain('Saved');
  });

  it('keeps the English formatters exactly as before', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('2 KB');
    expect(formatBytes(1572864)).toBe('1.5 MB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatSpeed(2097152)).toBe('2.0 MB/s');
    expect(formatEta(0)).toBe('--');
    expect(formatEta(42.2)).toBe('43s');
    expect(formatEta(600)).toBe('10m');
    expect(formatEta(3720)).toBe('1h 2m');
  });
});
