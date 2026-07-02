// Hand-off between the app shell (which owns the deep-link subscription and
// is always mounted) and the Dashboard (which knows how to submit a URL but
// may not be mounted when a link arrives).

let pending: string[] = [];
let consumer: ((url: string) => void) | null = null;

export function pushDeepLink(url: string) {
  if (consumer) consumer(url);
  else pending.push(url);
}

export function consumeDeepLinks(cb: (url: string) => void): () => void {
  consumer = cb;
  const queued = pending;
  pending = [];
  queued.forEach(cb);
  return () => {
    if (consumer === cb) consumer = null;
  };
}
