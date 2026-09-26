// The page a link was found on, remembered between receiving the link and
// queueing it. Only the browser extension knows it (it sends
// prism://add?url=…&referrer=…); some file hosts and embedded players only
// answer requests that come from that page. Validated again in Rust.

const MAX = 200;
const byUrl = new Map<string, string>();

function httpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') && raw.length <= 2048 ? u.toString() : null;
  } catch {
    return null;
  }
}

export function noteReferrer(url: string, referrer: string | null | undefined): void {
  const ref = httpUrl(referrer);
  if (!ref || ref === url) return;
  byUrl.delete(url);
  byUrl.set(url, ref);
  if (byUrl.size > MAX) byUrl.delete(byUrl.keys().next().value as string);
}

export function referrerFor(url: string | undefined): string | undefined {
  return url ? byUrl.get(url) : undefined;
}
