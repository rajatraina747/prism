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
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Keyboard shortcuts for the Transfers page. Inactive while an input has
 * focus or a dialog/menu is open (Radix marks those with data-state).
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
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]')) return;
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
