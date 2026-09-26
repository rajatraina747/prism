import { describe, it, expect } from 'vitest';
import { parsePrismDeepLink } from '@/services/utils';
import { referrerFor } from '../referrers';

describe('referrers from the browser extension', () => {
  it('remembers the page a link came from', () => {
    const link = 'https://files.example.com/big.iso';
    const deep = `prism://add?url=${encodeURIComponent(link)}&referrer=${encodeURIComponent('https://example.com/downloads')}`;
    expect(parsePrismDeepLink(deep)).toBe(link);
    expect(referrerFor(link)).toBe('https://example.com/downloads');
  });

  it('ignores a referrer that is not a web page', () => {
    const link = 'https://files.example.com/other.iso';
    parsePrismDeepLink(`prism://add?url=${encodeURIComponent(link)}&referrer=${encodeURIComponent('file:///etc/passwd')}`);
    expect(referrerFor(link)).toBeUndefined();
  });
});
