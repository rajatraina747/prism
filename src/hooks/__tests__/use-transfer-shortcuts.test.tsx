import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTransferShortcuts, type TransferShortcutHandlers } from '../use-transfer-shortcuts';

function handlers(): TransferShortcutHandlers {
  return {
    moveSelection: vi.fn(),
    selectAll: vi.fn(),
    togglePauseSelected: vi.fn(),
    toggleDetails: vi.fn(),
    removeSelected: vi.fn(),
    updateTracker: vi.fn(),
    clearSelection: vi.fn(),
  };
}

function press(key: string, target: EventTarget = document.body) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

afterEach(() => { document.body.innerHTML = ''; });

// Regression (REVIEW 2026-09-28 D-7)
describe('useTransferShortcuts', () => {
  it('acts on the selection when nothing else has focus', () => {
    const h = handlers();
    renderHook(() => useTransferShortcuts(h));
    press(' ');
    press('Enter');
    expect(h.togglePauseSelected).toHaveBeenCalledTimes(1);
    expect(h.toggleDetails).toHaveBeenCalledTimes(1);
  });

  it('leaves Enter and Space to a focused button', () => {
    const h = handlers();
    renderHook(() => useTransferShortcuts(h));
    const button = document.createElement('button');
    document.body.appendChild(button);
    press('Enter', button);
    press(' ', button);
    press('Backspace', button);
    expect(h.toggleDetails).not.toHaveBeenCalled();
    expect(h.togglePauseSelected).not.toHaveBeenCalled();
    expect(h.removeSelected).not.toHaveBeenCalled();
  });

  it('does nothing behind an open confirmation', () => {
    const h = handlers();
    renderHook(() => useTransferShortcuts(h));
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('data-state', 'open');
    document.body.appendChild(dialog);
    press('Enter');
    press(' ');
    expect(h.toggleDetails).not.toHaveBeenCalled();
    expect(h.togglePauseSelected).not.toHaveBeenCalled();
  });
});
