// Hand-off between the app shell (which owns the deep-link subscription and
// is always mounted) and the Dashboard (which knows how to submit a URL but
// may not be mounted when a link arrives).

import type { LinkOrigin } from '@/services/types';

type Consumer = (url: string, origin: LinkOrigin) => void;

let pending: { url: string; origin: LinkOrigin }[] = [];
let consumer: Consumer | null = null;

export function pushDeepLink(url: string, origin: LinkOrigin = 'app') {
  if (consumer) consumer(url, origin);
  else pending.push({ url, origin });
}

export function consumeDeepLinks(cb: Consumer): () => void {
  consumer = cb;
  const queued = pending;
  pending = [];
  queued.forEach(l => cb(l.url, l.origin));
  return () => {
    if (consumer === cb) consumer = null;
  };
}
