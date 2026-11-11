import { describe, it, expect } from 'vitest';
import { shortPeerAddress } from './peer-address';

describe('shortPeerAddress', () => {
  it('shows an IPv4 peer on a dual-stack socket as plain IPv4', () => {
    expect(shortPeerAddress('[::ffff:146.70.198.53]:54208')).toBe('146.70.198.53:54208');
  });

  it('leaves other addresses alone', () => {
    expect(shortPeerAddress('10.1.2.3:6881')).toBe('10.1.2.3:6881');
    expect(shortPeerAddress('[2001:db8::1]:6881')).toBe('[2001:db8::1]:6881');
  });
});
