import { useEffect } from 'react';

export interface TransferShortcutHandlers {
  moveSelection: (delta: 1 | -1) => void;
  selectAll: () => void;
  togglePauseSelected: () => void;
  toggleDetails: () => void;
  removeSelected: () => void;
  updateTracker: () => void;
  clearSelection: () => void;
}

function inEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  // A reorder handle uses the arrows to move its row, not the selection.
  if (target.closest('[data-reorder-handle]')) return true;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** A control that owns Enter/Space/Backspace itself: a button, link,
 * menu item, tab, switch or checkbox. Rows (`role="option"`) are not: the
 * keys act on the selection there. */
function isControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest(
    'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="switch"], [role="checkbox"], [role="slider"]',
  ) !== null;
}

/** An open modal or menu: the page behind it must not react to keys. */
const OPEN_OVERLAY =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]';

/**
 * Keyboard shortcuts for the Transfers page. Inactive while an input has
 * focus or a dialog/menu is open (Radix marks those with data-state), and
 * Enter/Space/Backspace/R leave a focused control alone.
 *
 *   ↑ / ↓          move the selection
 *   ⌘/Ctrl + A     select all visible rows
 *   Space          pause / resume the selection
 *   Enter          toggle the detail panel
 *   Delete / ⌫     remove the selection (confirms)
 *   R              update tracker for the selection
 *   Escape         clear the selection
 */
export function useTransferShortcuts(handlers: TransferShortcutHandlers, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (inEditable(e.target)) return;
      // Radix confirmations are role="alertdialog": missing it here, Enter in
      // "Remove and delete files" toggled the panel behind the dialog and
      // Space paused the selection (REVIEW 2026-09-28 D-7).
      if (document.querySelector(OPEN_OVERLAY)) return;
      // A focused button, link or toast action gets its own Enter and Space.
      if (isControl(e.target) && ['Enter', ' ', 'Backspace', 'Delete', 'r', 'R'].includes(e.key)) return;
      const meta = e.metaKey || e.ctrlKey;
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); handlers.moveSelection(1); break;
        case 'ArrowUp': e.preventDefault(); handlers.moveSelection(-1); break;
        case 'a': case 'A':
          if (meta) { e.preventDefault(); handlers.selectAll(); }
          break;
        case ' ': e.preventDefault(); handlers.togglePauseSelected(); break;
        case 'Enter': e.preventDefault(); handlers.toggleDetails(); break;
        case 'Delete': case 'Backspace': e.preventDefault(); handlers.removeSelected(); break;
        case 'r': case 'R':
          if (!meta) { e.preventDefault(); handlers.updateTracker(); }
          break;
        case 'Escape': handlers.clearSelection(); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers, enabled]);
}
