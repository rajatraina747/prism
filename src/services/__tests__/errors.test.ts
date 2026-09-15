import { describe, it, expect } from 'vitest';
import { classifyError, conciseError } from '../errors';

describe('classifyError', () => {
  it('offers browser cookies for sign-in walls', () => {
    for (const msg of [
      "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser",
      'ERROR: [instagram] x: Login required',
      'This video is age-restricted',
    ]) {
      expect(classifyError(msg)).toMatchObject({ category: 'auth', action: 'cookies' });
    }
  });

  it('offers nothing when retrying cannot help', () => {
    expect(classifyError('ERROR: [youtube] abc: Video unavailable').action).toBe('none');
    expect(classifyError('The uploader has not made this video available in your country').action).toBe('none');
    expect(classifyError('ERROR: Unsupported URL: https://example.com').action).toBe('none');
  });

  it('keeps network failures auto-retryable and unknown ones not', () => {
    expect(classifyError('Connection reset by peer')).toMatchObject({ category: 'network', action: 'retry' });
    expect(classifyError('HTTP Error 429: Too Many Requests').category).toBe('network');
    // 403 is usually the extractor, not the network: offer retry, don't auto-retry.
    expect(classifyError('HTTP Error 403: Forbidden')).toMatchObject({ category: 'unknown', action: 'retry' });
    expect(classifyError('something odd happened')).toMatchObject({ category: 'unknown', action: 'retry' });
  });
});

describe('conciseError', () => {
  it('keeps the last ERROR line without prefixes', () => {
    const raw = 'yt-dlp error: WARNING: [youtube] falling back\nERROR: [youtube] dQw4w9WgXcQ: Video unavailable. This video is private';
    expect(conciseError(raw)).toBe('Video unavailable. This video is private');
  });

  it('keeps sentences that merely start with a word and a colon-less phrase', () => {
    expect(conciseError('ERROR: [generic] Unable to download webpage: HTTP Error 404')).toBe('Unable to download webpage: HTTP Error 404');
  });

  it('falls back to the last line and caps length', () => {
    expect(conciseError('first\nsecond')).toBe('second');
    const long = conciseError(`ERROR: ${'x'.repeat(500)}`);
    expect(long.length).toBe(200);
    expect(long.endsWith('…')).toBe(true);
    expect(conciseError('Plain message')).toBe('Plain message');
  });
});
