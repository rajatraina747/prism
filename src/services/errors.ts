import type { DownloadError } from '@/types/models';

/** What the UI offers next to a failure. `cookies` opens the Browser cookies
 * setting; `retry` re-runs the item; `none` when retrying can't help (the
 * video is gone, region-locked, the URL isn't supported). */
export type FailureAction = 'retry' | 'cookies' | 'none';

export interface ClassifiedError {
  category: DownloadError['category'];
  suggestion: string;
  action: FailureAction;
}

/** Map a raw engine error to a category (drives auto-retry), a human
 * suggestion and the one action worth offering. Pattern-matches yt-dlp's
 * English messages — structured errors from Rust are a v2.0 idea. */
export function classifyError(msg: string): ClassifiedError {
  const lower = msg.toLowerCase();
  // Auth / access walls (yt-dlp phrases these many ways)
  if (lower.includes('sign in to confirm') || lower.includes('not a bot') || lower.includes('login required')
    || lower.includes('private video') || lower.includes('members-only') || lower.includes('age-restricted')
    || lower.includes('age restricted') || lower.includes('confirm your age') || lower.includes('cookies'))
    return { category: 'auth', suggestion: 'This video needs you to be signed in — choose a browser where you\'re logged in under Browser cookies', action: 'cookies' };
  // Gone / never existed
  if (lower.includes('video unavailable') || lower.includes('has been removed') || lower.includes('account terminated')
    || lower.includes('no longer available') || lower.includes('404'))
    return { category: 'parse', suggestion: 'This video is no longer available', action: 'none' };
  // Region locks
  // ("…has not made this video available in your country" is yt-dlp's wording)
  if (lower.includes('available in your country') || lower.includes('geo restrict') || lower.includes('georestrict'))
    return { category: 'parse', suggestion: 'Not available in your region', action: 'none' };
  // Rate limiting — transient, but retrying immediately makes it worse
  if (lower.includes('429') || lower.includes('too many requests') || lower.includes('rate limit'))
    return { category: 'network', suggestion: 'Rate limited by the site — wait a few minutes, then retry', action: 'retry' };
  // The site refused the request: usually extraction changed under the engine
  if (lower.includes('403') || lower.includes('forbidden'))
    return { category: 'unknown', suggestion: 'The site refused the download — update the engine in Settings → Updates, then retry', action: 'retry' };
  if (lower.includes('permission') || lower.includes('access denied'))
    return { category: 'permission', suggestion: 'Prism can\'t write there — pick another download folder in Settings → Storage', action: 'none' };
  if (lower.includes('disk') || lower.includes('space') || lower.includes('no space') || lower.includes('full'))
    return { category: 'storage', suggestion: 'Free up disk space, then retry', action: 'retry' };
  if (lower.includes('codec') || lower.includes('format') || lower.includes('merge') || lower.includes('remux'))
    return { category: 'unknown', suggestion: 'Try a different quality', action: 'retry' };
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('connection') || lower.includes('network')
    || lower.includes('dns') || lower.includes('ssl') || lower.includes('unable to download'))
    return { category: 'network', suggestion: 'Check your connection, then retry', action: 'retry' };
  if (lower.includes('not found') || lower.includes('unsupported') || lower.includes('unable to extract'))
    return { category: 'parse', suggestion: 'This link may not be supported', action: 'none' };
  // Unknown errors must NOT classify as 'network' — that category triggers
  // automatic retries, which is wrong for failures we can't identify.
  return { category: 'unknown', suggestion: 'Check the link, then retry', action: 'retry' };
}

const MAX_CONCISE = 200;

/** The one line of a raw engine error worth showing: the last `ERROR:` line
 * (else the last line), minus the `yt-dlp error:`/`ERROR:` and
 * `[extractor] id:` prefixes, capped in length. The full text stays in the
 * tooltip and the diagnostics log. */
export function conciseError(raw: string): string {
  const body = raw.trim().replace(/^yt-dlp error:\s*/i, '');
  const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const pick = [...lines].reverse().find(l => /^ERROR:/i.test(l)) ?? lines[lines.length - 1] ?? body;
  const line = pick
    .replace(/^ERROR:\s*/i, '')
    .replace(/^\[[^\]]+\]\s*(?:[\w-]+:\s+)?/, '')
    .trim();
  if (!line) return raw.trim();
  return line.length > MAX_CONCISE ? `${line.slice(0, MAX_CONCISE - 1)}…` : line;
}
