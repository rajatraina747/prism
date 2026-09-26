import { describe, it, expect } from 'vitest';
import { createLimiter } from '../limit';

describe('createLimiter', () => {
  it('never runs more than n at once, and runs them all', async () => {
    const limit = createLimiter(2);
    let running = 0;
    let peak = 0;
    const results = await Promise.all([1, 2, 3, 4, 5].map(i => limit(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, 5));
      running--;
      return i * 10;
    })));
    expect(peak).toBe(2);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('a failure frees its slot', async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(await limit(async () => 'next')).toBe('next');
  });
});
