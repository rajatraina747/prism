// Hand-off between the app shell (which owns the deep-link subscription, the
// Add sheet and window drops, and is always mounted) and the Dashboard (which
// knows how to submit links but may not be mounted when they arrive).

import type { LinkOrigin } from '@/services/types';

type Consumer = (urls: string[], origin: LinkOrigin) => void;

let pending: { urls: string[]; origin: LinkOrigin }[] = [];
let consumer: Consumer | null = null;

/** One link, or several added together (a batch from the Add sheet or a drop). */
export function pushDeepLink(urls: string | string[], origin: LinkOrigin = 'app') {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (list.length === 0) return;
  if (consumer) consumer(list, origin);
  else pending.push({ urls: list, origin });
}

export function consumeDeepLinks(cb: Consumer): () => void {
  consumer = cb;
  const queued = pending;
  pending = [];
  queued.forEach(l => cb(l.urls, l.origin));
  return () => {
    if (consumer === cb) consumer = null;
  };
}
