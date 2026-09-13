import { describe, it, expect } from 'vitest';
import { parsePrismDeepLink } from '../utils';

// The deep-link validator is the boundary between "any website/extension can
// hand Prism a string" and "Prism fetches metadata for it" — every rejection
// here is a class of link the app must never act on.
describe('parsePrismDeepLink', () => {
  it('accepts prism://add with an http(s) url (host and path forms)', () => {
    expect(parsePrismDeepLink('prism://add?url=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Dabc'))
      .toBe('https://youtube.com/watch?v=abc');
    expect(parsePrismDeepLink('prism:/add?url=http%3A%2F%2Fexample.com%2Fv'))
      .toBe('http://example.com/v');
  });

  it('rejects other schemes even when they carry a url param', () => {
    expect(parsePrismDeepLink('https://evil.example/add?url=https%3A%2F%2Fyoutube.com')).toBeNull();
    expect(parsePrismDeepLink('magnet:?xt=urn:btih:abc')).toBeNull();
    expect(parsePrismDeepLink('file:///Users/me/x.mp4')).toBeNull();
  });

  it('rejects unknown actions', () => {
    expect(parsePrismDeepLink('prism://settings?url=https%3A%2F%2Fyoutube.com')).toBeNull();
    expect(parsePrismDeepLink('prism://?url=https%3A%2F%2Fyoutube.com')).toBeNull();
  });

  it('rejects non-http(s) targets', () => {
    expect(parsePrismDeepLink('prism://add?url=file%3A%2F%2F%2Fetc%2Fpasswd')).toBeNull();
    expect(parsePrismDeepLink('prism://add?url=javascript%3Aalert(1)')).toBeNull();
    expect(parsePrismDeepLink('prism://add?url=prism%3A%2F%2Fadd')).toBeNull();
    expect(parsePrismDeepLink('prism://add?url=ftp%3A%2F%2Fx%2Fy')).toBeNull();
  });

  it('rejects missing or unparseable targets and garbage', () => {
    expect(parsePrismDeepLink('prism://add')).toBeNull();
    expect(parsePrismDeepLink('prism://add?url=')).toBeNull();
    expect(parsePrismDeepLink('prism://add?url=not%20a%20url')).toBeNull();
    expect(parsePrismDeepLink('')).toBeNull();
    expect(parsePrismDeepLink('   ')).toBeNull();
  });
});
