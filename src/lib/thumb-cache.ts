// Thumbnails from this machine rather than from the sites (see
// src-tauri/src/thumbnails.rs). The desktop service registers a resolver that
// fetches a picture once, through the proxy, and hands back a local URL; the
// web demo and tests register none and keep showing the remote picture.

import { useEffect, useState } from 'react';
import { createLimiter } from '@/lib/limit';

type Resolver = (url: string) => Promise<string>;

let resolver: Resolver | null = null;
const resolved = new Map<string, Promise<string | null>>();
// A Library screen can ask for dozens at once.
const limit = createLimiter(4);

export function setThumbResolver(next: Resolver | null): void {
  resolver = next;
  resolved.clear();
}

export function thumbResolverActive(): boolean {
  return resolver !== null;
}

function resolve(url: string): Promise<string | null> {
  let pending = resolved.get(url);
  if (!pending) {
    const r = resolver;
    pending = r ? limit(() => r(url)).catch(() => null) : Promise.resolve(null);
    resolved.set(url, pending);
  }
  return pending;
}

/** The local copy of a remote thumbnail: `undefined` while it is fetched,
 * `null` when it couldn't be, or its local URL. Without a resolver: null. */
export function useCachedThumb(url: string | undefined): string | null | undefined {
  const remote = !!url && /^https?:/i.test(url);
  const [local, setLocal] = useState<string | null | undefined>(remote && resolver ? undefined : null);
  useEffect(() => {
    if (!remote || !url || !resolver) {
      setLocal(null);
      return;
    }
    let live = true;
    setLocal(undefined);
    void resolve(url).then(src => { if (live) setLocal(src); });
    return () => { live = false; };
  }, [url, remote]);
  return local;
}
