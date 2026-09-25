// Whether the page may load pictures from the internet (thumbnails).
//
// The webview fetches an <img> itself, straight to the site, never through
// the proxy the downloads use. Someone who set a proxy to keep their address
// from the sites they download from would still be announcing it on every
// Library render (REVIEW 2026-09-26 M6). So with a proxy set, thumbnails are
// not loaded at all and the neutral tile shows instead.

import { useSyncExternalStore } from 'react';

let allowed = true;
const listeners = new Set<() => void>();

export function setRemoteImagesAllowed(next: boolean): void {
  if (next === allowed) return;
  allowed = next;
  listeners.forEach(l => l());
}

export function remoteImagesAllowed(): boolean {
  return allowed;
}

export function useRemoteImagesAllowed(): boolean {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => allowed,
  );
}
