import type { Subscription, PlaylistEntry, DownloadItem, AppPreferences } from '@/types/models';
import { generateId, sanitizeFilename, classifyLink, siteKey } from '@/services/utils';

// Pure logic for a subscription check: diff the feed against what we've seen
// and build queue items for the new entries. IO (parsePlaylist, addToQueue,
// persistence) stays in SubscriptionsProvider.

// Cap the remembered-URL set so subscriptions.json can't grow unboundedly.
// Feeds are checked newest-first, so keeping the most recent N is safe as
// long as N comfortably exceeds one check interval's worth of uploads.
const SEEN_URLS_CAP = 1000;

export interface SubscriptionCheckResult {
  newEntries: PlaylistEntry[];
  seenUrls: string[];
  /** Premieres and live streams, left unseen until they can be downloaded. */
  pendingUrls: string[];
}

/** A premiere or scheduled stream that hasn't aired, or a stream that is
 * live now: neither is a finished video yet. Queued, they failed, and being
 * marked seen they were never taken once they had aired (REVIEW 2026-09-26). */
export function notYetDownloadable(entry: PlaylistEntry): boolean {
  return entry.liveStatus === 'is_upcoming' || entry.liveStatus === 'is_live';
}

/** Run the full (yt-dlp) check at least this often even when the RSS feed
 * shows nothing new. */
export const FULL_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** The video id in a YouTube URL: watch, shorts, live, embed, youtu.be, and
 * the `/v/ID` that YouTube's own RSS feed carries as each entry's media. */
export function youtubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1) || null;
    if (host !== 'youtube.com') return null;
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Whether the RSS feed shows nothing the last full check didn't already
 * see, so the yt-dlp check can be skipped. Never while a premiere is
 * waiting, and never past FULL_CHECK_EVERY_MS. */
export function feedShowsNothingNew(sub: Subscription, feed: PlaylistEntry[], now: Date): boolean {
  if (!sub.feedIds?.length || sub.pendingUrls?.length || !sub.lastFullCheckAt) return false;
  if (now.getTime() - Date.parse(sub.lastFullCheckAt) >= FULL_CHECK_EVERY_MS) return false;
  const known = new Set(sub.feedIds);
  const ids = feed.map(e => youtubeVideoId(e.url)).filter((id): id is string => id !== null);
  return ids.length > 0 && ids.every(id => known.has(id));
}

/** Whether a feed entry is one this subscription wants.
 *
 * Matching is on the title and the URL, because a flat feed entry carries
 * nothing else — there is no description or tag list to match against, and
 * duration is often 0 until the video is actually parsed.
 *
 * Exclude beats include: someone who writes both means "these, but never
 * those". An empty include list means everything, rather than nothing, since
 * that is what a subscription with no rules has always meant. */
export function entryMatches(sub: Subscription, entry: PlaylistEntry): boolean {
  const clean = (words?: string[]) =>
    (words ?? []).map(w => w.trim().toLowerCase()).filter(Boolean);
  const include = clean(sub.includeKeywords);
  const exclude = clean(sub.excludeKeywords);
  if (include.length === 0 && exclude.length === 0) return true;

  const haystack = `${entry.title}\n${entry.url}`.toLowerCase();
  if (exclude.some(word => haystack.includes(word))) return false;
  return include.length === 0 || include.some(word => haystack.includes(word));
}

/** Entries in the feed that this subscription hasn't seen yet, plus the
 * updated (capped) seen set.
 *
 * Filtering happens after the seen set is built, deliberately: a video that
 * the rules reject is still *seen*. Otherwise every poll would reconsider it
 * forever, and loosening the rules later would suddenly download a channel's
 * whole back catalogue. */
export function diffFeed(sub: Subscription, feed: PlaylistEntry[]): SubscriptionCheckResult {
  const seen = new Set(sub.seenUrls);
  const pending = new Set(feed.filter(notYetDownloadable).map(e => e.url));
  const newEntries = feed.filter(e => !seen.has(e.url) && !pending.has(e.url) && entryMatches(sub, e));
  // Feed order first (newest first), then previously-seen URLs, capped. A
  // premiere or live stream stays out, so it is new again once it has aired.
  const merged = [
    ...feed.map(e => e.url).filter(u => !pending.has(u)),
    ...sub.seenUrls.filter(u => !feed.some(e => e.url === u)),
  ];
  return { newEntries, seenUrls: merged.slice(0, SEEN_URLS_CAP), pendingUrls: [...pending].filter(u => !seen.has(u)) };
}

/** Whether a feed entry's link may be queued without anyone confirming it.
 *
 * A subscription polls on its own, and what a feed lists can change after
 * someone subscribed to it. So only links that go out to the internet: http(s)
 * to a public host name or address, or a magnet. Not a local file, not
 * `localhost`, a private or link-local address or a `.local` name — a feed
 * must not be able to make Prism send requests into the user's own network
 * (a router's admin page) on a schedule (REVIEW 2026-09-26 M1). */
export function feedEntryAllowed(url: string): boolean {
  const trimmed = url.trim();
  if (/^magnet:\?/i.test(trimmed)) return true;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !host.includes(':')) return false; // single label: localhost, intranet names
  if (host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.lan')) return false;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  }
  if (host.includes(':')) {
    // IPv6 literal: loopback, unspecified, unique-local, link-local, v4-mapped.
    if (host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:')) return false;
  }
  return true;
}

/** Whether a feed entry lives on the subscription's own site, so it may use
 * the browser's cookies the way a link pasted from that site would. Compared
 * by site (`www.`/`m.` ignored), a subdomain of the subscription's site
 * counts as the same site. */
export function sameSiteAsSubscription(entryUrl: string, subUrl: string): boolean {
  const a = siteKey(entryUrl);
  const b = siteKey(subUrl);
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`);
}

/** Build a queue item for a feed entry. Format is left null so the backend
 * picks its default best-quality H.264/AAC chain — flat playlist entries
 * don't carry format lists. */
export function entryToDownloadItem(
  entry: PlaylistEntry,
  sub: Subscription,
  prefs: AppPreferences,
): DownloadItem {
  const speedLimitBytes = prefs.bandwidthLimit > 0 ? prefs.bandwidthLimit * 1024 * 1024 : 0;
  return {
    id: generateId(),
    metadata: {
      title: entry.title,
      duration: entry.duration,
      thumbnail: entry.thumbnail,
      source: {
        url: entry.url,
        domain: extractDomain(entry.url),
        addedAt: new Date().toISOString(),
      },
      formats: [],
      uploader: sub.title,
    },
    settings: {
      format: null,
      destination: prefs.defaultSaveFolder,
      // sanitizeFilename keeps unicode titles (CJK, Cyrillic, …) intact — the
      // old \w-only strip reduced them to 'video' and collided on dedupe.
      filename: sanitizeFilename(entry.title),
      retryCount: prefs.defaultRetryCount,
      startImmediately: true,
      audioOnly: sub.audioOnly || undefined,
      speedLimit: speedLimitBytes || undefined,
      // A feed's own category wins over the site/engine rules, the same way a
      // category chosen by hand does: addToQueue leaves a pre-set id alone.
      categoryId: sub.categoryId || undefined,
      // Links to another site don't get the browser's cookies (M1).
      noCookies: !sameSiteAsSubscription(entry.url, sub.url) || undefined,
      // The same video can reach several feeds (a channel and a playlist of
      // it) under different URLs; yt-dlp's archive knows it by its id.
      useArchive: true,
    },
    status: 'queued',
    progress: 0,
    speed: 0,
    eta: 0,
    downloadedBytes: 0,
    totalBytes: 500_000_000,
    retryAttempt: 0,
    // An RSS enclosure can be a magnet or a plain file rather than a page, so
    // the engine is chosen from the URL — with the same rule the Dashboard
    // uses, so a feed link and a pasted link behave identically. Channel feeds
    // classify as 'http' and go to yt-dlp exactly as before.
    kind: classifyLink(entry.url),
  };
}

/** Which fetcher to try first for a feed URL.
 *
 * Only a guess, and deliberately a cheap one: the caller falls back to the
 * other fetcher if this is wrong, so the cost of guessing badly is one wasted
 * request rather than a failed subscription. It exists so that pasting a
 * podcast URL doesn't sit through a long yt-dlp parse first. */
export function likelyFeedType(url: string): 'channel' | 'rss' {
  const clean = url.trim().toLowerCase();
  const path = clean.split(/[?#]/)[0];
  if (/\.(rss|atom|xml)$/.test(path)) return 'rss';
  if (/(^|[/.])(rss|feed|feeds|atom)([/.]|$)/.test(path)) return 'rss';
  return 'channel';
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}
