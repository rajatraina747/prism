// Hand-off between the app shell (which owns the deep-link subscription, the
// Add sheet and window drops, and is always mounted) and the Dashboard (which
// knows how to submit links but may not be mounted when they arrive).

import type { LinkOrigin } from '@/services/types';
import type { BatchChoice } from '@/types/models';

type Consumer = (urls: string[], origin: LinkOrigin, choice?: BatchChoice) => void;

let pending: { urls: string[]; origin: LinkOrigin; choice?: BatchChoice }[] = [];
let consumer: Consumer | null = null;

/** One link, or several added together (a batch from the Add sheet or a drop).
 * `choice` is how to download a batch, when it has already been asked. */
export function pushDeepLink(urls: string | string[], origin: LinkOrigin = 'app', choice?: BatchChoice) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (list.length === 0) return;
  if (consumer) consumer(list, origin, choice);
  else pending.push({ urls: list, origin, choice });
}

export function consumeDeepLinks(cb: Consumer): () => void {
  consumer = cb;
  const queued = pending;
  pending = [];
  queued.forEach(l => cb(l.urls, l.origin, l.choice));
  return () => {
    if (consumer === cb) consumer = null;
  };
}
