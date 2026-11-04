import { useEffect, type RefObject } from 'react';

/** ⌘F / Ctrl+F puts the cursor in this page's search box (and selects what's
 * in it), the way a desktop app's Find does. */
export function useFindShortcut(ref: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        if (!ref.current) return;
        e.preventDefault();
        ref.current.focus();
        ref.current.select();
      }
    };
    // Capture phase: a list that handles its own keys (the Library's
    // selectable cards) would otherwise swallow it after a click.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ref]);
}
