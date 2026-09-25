import { describe, it, expect } from 'vitest';
import { scrubText } from '../crash-reporting';

// Regression (REVIEW 2026-09-26 L1): a crash report must not carry a
// download's name, wherever on disk it lives.
describe('scrubText', () => {
  it('removes URLs and paths on every kind of drive, spaces included', () => {
    for (const path of [
      '/Users/me/Downloads/Secret Title.mkv',
      '/Volumes/Media/Films/Secret Title.mkv',
      'D:\\Films\\Secret Title.mkv',
      '\\\\nas\\share\\Secret Title.mkv',
      '/mnt/nas/Secret Title.mkv',
      '~/Downloads/Secret Title.mkv',
    ]) {
      const s = scrubText(`could not open ${path}`);
      expect(s, path).not.toMatch(/Secret|Title/);
      expect(s).toContain('[path]');
    }
    expect(scrubText('fetch https://youtube.com/watch?v=abc failed')).toBe('fetch [url] failed');
  });

  it('leaves ordinary messages alone', () => {
    expect(scrubText('TypeError: x is undefined')).toBe('TypeError: x is undefined');
  });
});
