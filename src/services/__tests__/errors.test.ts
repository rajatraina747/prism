import { describe, it, expect } from 'vitest';
import { classifyError, conciseError, errorText, isEngineError } from '../errors';

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

describe('structured engine errors', () => {
  it('uses the code Rust assigned over the message text', () => {
    // The text alone would read as a network failure.
    expect(classifyError('connection closed', 'auth')).toMatchObject({ category: 'auth', action: 'cookies' });
    expect(classifyError('whatever', 'disk_full')).toMatchObject({ category: 'storage', action: 'retry' });
    expect(classifyError('whatever', 'unsupported').action).toBe('none');
    expect(classifyError('whatever', 'engine_missing').action).toBe('none');
  });

  it('falls back to reading the message for unknown codes', () => {
    expect(classifyError('Connection reset by peer', 'unknown').category).toBe('network');
  });

  it('normalises engine errors, strings and Errors', () => {
    expect(errorText({ code: 'geo', summary: 'Not in your country', detail: 'ERROR: x', retryable: false }))
      .toEqual({ message: 'Not in your country', detail: 'ERROR: x', engineCode: 'geo' });
    expect(errorText('plain')).toEqual({ message: 'plain' });
    expect(errorText(new Error('boom'))).toEqual({ message: 'boom' });
    expect(errorText(undefined, 'fallback')).toEqual({ message: 'fallback' });
    expect(isEngineError({ code: 'x' })).toBe(false);
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
