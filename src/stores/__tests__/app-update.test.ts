import { describe, it, expect, vi } from 'vitest';
import { installAppUpdate, getUpdateInstall, formatUpdateProgress } from '../app-update';

// Regression (2.0.2 → 2.0.3 update, 2026-09-23): a second Install started a
// second download beside the first, and Settings showed no progress at all.
describe('installAppUpdate', () => {
  it('joins an install already running instead of starting another', async () => {
    let finish!: () => void;
    let report!: (d: number, t: number | null) => void;
    const install = vi.fn((onProgress: (d: number, t: number | null) => void) => {
      report = onProgress;
      return new Promise<void>(r => { finish = r; });
    });
    const first = installAppUpdate(install);
    const second = installAppUpdate(install);
    expect(install).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    report(50, 200);
    expect(getUpdateInstall()).toEqual({ installing: true, downloaded: 50, total: 200 });

    finish();
    await first;
    expect(getUpdateInstall().installing).toBe(false);
  });

  it('can be tried again after a failure', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('network')));
    await expect(installAppUpdate(failing)).rejects.toThrow('network');
    expect(getUpdateInstall().installing).toBe(false);
    const ok = vi.fn(() => Promise.resolve());
    await installAppUpdate(ok);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe('formatUpdateProgress', () => {
  it('shows a percentage when the size is known', () => {
    expect(formatUpdateProgress({ installing: true, downloaded: 67_000_000, total: 134_000_000 })).toMatch(/^50% · /);
  });
  it('shows bytes, or that it is starting, when it is not', () => {
    expect(formatUpdateProgress({ installing: true, downloaded: 0, total: null })).toBe('Starting download…');
    expect(formatUpdateProgress({ installing: true, downloaded: 2048, total: null })).toMatch(/downloaded$/);
  });
});
