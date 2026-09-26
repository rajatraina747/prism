import type { DownloadError } from '@/types/models';
import type { EngineErrorCode } from '@/services/errors';

// When a failed download is tried again on its own, and after how long.
//
// The budget is the "Retries on failure" setting. It used to be shown in
// Settings and saved on every item but never read: the retry count was fixed
// at two, and a rate limit was retried after five seconds — which is how a
// temporary block becomes a longer one.

/** Waits after a rate limit: the site asked to be left alone, so minutes. */
const RATE_LIMIT_WAITS_MS = [60_000, 5 * 60_000, 15 * 60_000];
/** Connection trouble: short, doubling, capped at a minute. */
const NETWORK_FIRST_WAIT_MS = 5_000;
const NETWORK_MAX_WAIT_MS = 60_000;
/** Prism's own concurrency cap was full: it frees up on its own. */
const BUSY_WAIT_MS = 10_000;

function isRateLimit(code: EngineErrorCode | undefined, message: string): boolean {
  return code === 'rate_limited' || /\b429\b|too many requests|rate.?limit/i.test(message);
}

/** How long to wait before retrying automatically, or null to give up and
 * report the failure. `attempt` is how many automatic retries already ran. */
export function autoRetryDelayMs(
  attempt: number,
  budget: number,
  category: DownloadError['category'],
  code: EngineErrorCode | undefined,
  message: string,
): number | null {
  if (attempt >= Math.max(0, budget)) return null;
  if (isRateLimit(code, message)) {
    return RATE_LIMIT_WAITS_MS[Math.min(attempt, RATE_LIMIT_WAITS_MS.length - 1)];
  }
  if (code === 'busy') return BUSY_WAIT_MS;
  if (category === 'network') {
    return Math.min(NETWORK_FIRST_WAIT_MS * 2 ** attempt, NETWORK_MAX_WAIT_MS);
  }
  return null;
}
