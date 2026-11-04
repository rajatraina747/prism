import { describe, expect, it } from 'vitest';
import { matchesQuery } from './query';

describe('settings search', () => {
  it('matches every word anywhere in the label, description or group', () => {
    expect(matchesQuery('dl limit', 'Download limit', undefined, 'Speed limits (0 = unlimited)')).toBe(false);
    expect(matchesQuery('speed limit', 'Download limit', 'MB/s', 'Speed limits (0 = unlimited)')).toBe(true);
    expect(matchesQuery('THEME', 'Theme', 'Application color scheme')).toBe(true);
    expect(matchesQuery('', 'anything')).toBe(true);
    expect(matchesQuery('dht peers', 'DHT', 'Find peers without a tracker')).toBe(true);
  });
});
