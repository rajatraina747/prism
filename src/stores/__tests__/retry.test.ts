import { describe, it, expect } from 'vitest';
import { autoRetryDelayMs } from '@/stores/retry';

describe('autoRetryDelayMs', () => {
  it('follows the Retries on failure setting', () => {
    expect(autoRetryDelayMs(0, 3, 'network', 'network', 'reset')).not.toBeNull();
    expect(autoRetryDelayMs(2, 3, 'network', 'network', 'reset')).not.toBeNull();
    expect(autoRetryDelayMs(3, 3, 'network', 'network', 'reset')).toBeNull();
    expect(autoRetryDelayMs(0, 0, 'network', 'network', 'reset')).toBeNull();
  });

  it('backs off connection trouble, capped at a minute', () => {
    expect(autoRetryDelayMs(0, 10, 'network', 'timeout', '')).toBe(5_000);
    expect(autoRetryDelayMs(1, 10, 'network', 'timeout', '')).toBe(10_000);
    expect(autoRetryDelayMs(8, 10, 'network', 'timeout', '')).toBe(60_000);
  });

  it('waits minutes after a rate limit, coded or not', () => {
    expect(autoRetryDelayMs(0, 5, 'network', 'rate_limited', '')).toBe(60_000);
    expect(autoRetryDelayMs(1, 5, 'network', 'rate_limited', '')).toBe(300_000);
    expect(autoRetryDelayMs(4, 5, 'network', 'rate_limited', '')).toBe(900_000);
    expect(autoRetryDelayMs(0, 5, 'network', undefined, 'HTTP Error 429: Too Many Requests')).toBe(60_000);
  });

  it('retries a busy engine shortly', () => {
    expect(autoRetryDelayMs(0, 3, 'unknown', 'busy', '')).toBe(10_000);
  });

  it('never retries what retrying cannot fix', () => {
    expect(autoRetryDelayMs(0, 3, 'auth', 'auth', 'Sign in to confirm')).toBeNull();
    expect(autoRetryDelayMs(0, 3, 'parse', 'unavailable', '')).toBeNull();
    expect(autoRetryDelayMs(0, 3, 'unknown', undefined, 'something odd')).toBeNull();
  });
});
