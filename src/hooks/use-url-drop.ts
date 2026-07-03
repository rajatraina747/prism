import { useEffect, useRef } from 'react';

/** Extract the first http(s) URL from a drop's dataTransfer, if any. */
function urlFromDataTransfer(dt: DataTransfer | null): string | null {
  if (!dt) return null;
  // Browsers put dragged links in text/uri-list (first non-comment line);
  // plain text drags (e.g. selected text) fall back to text/plain.
  const uriList = dt.getData('text/uri-list');
  const fromList = uriList
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !l.startsWith('#'));
  const candidate = fromList || dt.getData('text/plain').trim();
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    return u.protocol === 'http:' || u.protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

/** Accept URLs dragged onto the window (browser tabs, address bars, links)
 * and hand them to `onUrl` — callers route them like deep links. */
export function useUrlDrop(onUrl: (url: string) => void) {
  const onUrlRef = useRef(onUrl);
  onUrlRef.current = onUrl;

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      // Required to make the window a valid drop target
      e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const url = urlFromDataTransfer(e.dataTransfer);
      if (url) onUrlRef.current(url);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
}
