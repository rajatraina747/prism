import { useEffect, useRef, useState } from 'react';
import { linksFromDrop, type DropResult } from '@/lib/add-links';

/** Set by in-app drags (Transfers reordering) so the window doesn't treat
 * them as something to add. */
export const INTERNAL_DRAG_TYPE = 'application/x-prism-internal';

function isAddableDrag(e: DragEvent): boolean {
  const types = Array.from(e.dataTransfer?.types ?? []);
  if (types.includes(INTERNAL_DRAG_TYPE)) return false;
  return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain');
}

/** Accept drops anywhere in the window: links from a browser, magnet text,
 * `.torrent` files and text files of links. Returns whether an addable drag
 * is over the window (for the overlay). */
export function useDropToAdd(
  importTorrent: (name: string, bytes: Uint8Array) => Promise<string>,
  onResult: (result: DropResult) => void,
): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const latest = useRef({ importTorrent, onResult });
  latest.current = { importTorrent, onResult };

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!isAddableDrag(e)) return;
      depth.current += 1;
      setDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!isAddableDrag(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDragOver = (e: DragEvent) => {
      // Required to make the window a valid drop target
      e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (!e.dataTransfer || !isAddableDrag(e)) return;
      linksFromDrop(e.dataTransfer, latest.current.importTorrent)
        .then(r => latest.current.onResult(r))
        .catch(() => {});
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return dragging;
}
