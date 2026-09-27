import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const readClipboard = vi.fn();
vi.mock('@/services/ServiceProvider', () => ({ useService: () => ({ readClipboard }) }));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  readClipboard.mockReset();
});

// Regression (REVIEW 2026-09-28 S-4): whatever was copied — a password —
// was written to localStorage before it was even checked.
describe('useClipboardWatcher', () => {
  it('never stores what was copied, only a fingerprint', async () => {
    const { useClipboardWatcher } = await import('../use-clipboard-watcher');
    readClipboard.mockResolvedValue('hunter2-secret-password');
    const onUrl = vi.fn();
    renderHook(() => useClipboardWatcher(onUrl));
    await waitFor(() => expect(readClipboard).toHaveBeenCalled());
    await waitFor(() => expect(localStorage.getItem('prism.clipboard.lastSeen')).toMatch(/^fp:/));
    expect(JSON.stringify(localStorage)).not.toContain('hunter2');
    expect(onUrl).not.toHaveBeenCalled();
  });

  it('offers a video link once, and replaces text an older version stored', async () => {
    localStorage.setItem('prism.clipboard.lastSeen', 'an old secret');
    const { useClipboardWatcher } = await import('../use-clipboard-watcher');
    expect(localStorage.getItem('prism.clipboard.lastSeen')).toMatch(/^fp:/);
    readClipboard.mockResolvedValue('https://www.youtube.com/watch?v=abc');
    const onUrl = vi.fn();
    const first = renderHook(() => useClipboardWatcher(onUrl));
    await waitFor(() => expect(onUrl).toHaveBeenCalledTimes(1));
    first.unmount();
    renderHook(() => useClipboardWatcher(onUrl));
    await new Promise(r => setTimeout(r, 20));
    expect(onUrl).toHaveBeenCalledTimes(1);
  });
});
