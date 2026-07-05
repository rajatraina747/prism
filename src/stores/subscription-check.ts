import type { Subscription, PlaylistEntry, DownloadItem, AppPreferences } from '@/types/models';
import { generateId, sanitizeFilename } from '@/services/utils';

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
}

/** Entries in the feed that this subscription hasn't seen yet, plus the
 * updated (capped) seen set. */
export function diffFeed(sub: Subscription, feed: PlaylistEntry[]): SubscriptionCheckResult {
  const seen = new Set(sub.seenUrls);
  const newEntries = feed.filter(e => !seen.has(e.url));
  // Feed order first (newest first), then previously-seen URLs, capped.
  const merged = [...feed.map(e => e.url), ...sub.seenUrls.filter(u => !feed.some(e => e.url === u))];
  return { newEntries, seenUrls: merged.slice(0, SEEN_URLS_CAP) };
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
    },
    status: 'queued',
    progress: 0,
    speed: 0,
    eta: 0,
    downloadedBytes: 0,
    totalBytes: 500_000_000,
    retryAttempt: 0,
  };
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}
