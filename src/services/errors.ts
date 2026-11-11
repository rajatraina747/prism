import type { DownloadError } from '@/types/models';
import { t } from '@/i18n';

/** What the UI offers next to a failure. `cookies` opens the Browser cookies
 * setting; `engine` opens Updates, for failures a newer yt-dlp usually fixes;
 * `retry` re-runs the item; `none` when retrying can't help (the video is
 * gone, region-locked, the URL isn't supported). */
export type FailureAction = 'retry' | 'cookies' | 'engine' | 'none';

export interface ClassifiedError {
  category: DownloadError['category'];
  suggestion: string;
  action: FailureAction;
}

/** Codes from src-tauri/src/errors.rs (`ErrorCode`, snake_case). */
export type EngineErrorCode =
  | 'network' | 'timeout' | 'auth' | 'geo' | 'unavailable' | 'rate_limited'
  | 'forbidden' | 'disk_full' | 'permission' | 'not_found' | 'unsupported'
  | 'format' | 'checksum' | 'engine_missing' | 'invalid_input' | 'busy'
  | 'cancelled' | 'already_downloaded' | 'unknown';

/** A structured error from Rust: what commands reject with and what
 * download-complete events carry since 2.0. */
export interface EngineError {
  code: EngineErrorCode;
  summary: string;
  /** Engine output, already redacted and capped in Rust. */
  detail?: string;
  retryable: boolean;
}

export function isEngineError(value: unknown): value is EngineError {
  return typeof value === 'object' && value !== null
    && typeof (value as EngineError).code === 'string'
    && typeof (value as EngineError).summary === 'string';
}

export interface ErrorText {
  message: string;
  detail?: string;
  engineCode?: EngineErrorCode;
}

/** Normalise whatever a command rejected with or an event carried: an
 * EngineError (2.0+), a plain string (history saved before 2.0, the web
 * demo), or an Error. */
export function errorText(value: unknown, fallback = t('errors.unexpected')): ErrorText {
  if (isEngineError(value)) return { message: value.summary || fallback, detail: value.detail, engineCode: value.code };
  if (typeof value === 'string') return { message: value || fallback };
  if (value instanceof Error) return { message: value.message || fallback };
  return { message: fallback };
}

const LINK_UNSUPPORTED: ClassifiedError = { category: 'parse', suggestion: t('errors.unsupported'), action: 'none' };
const CHECK_CONNECTION: ClassifiedError = { category: 'network', suggestion: t('errors.network'), action: 'retry' };

/** Suggestions for codes Rust already classified. `unknown` is absent on
 * purpose: those fall back to reading the message. */
const BY_CODE: Partial<Record<EngineErrorCode, ClassifiedError>> = {
  auth: { category: 'auth', suggestion: t('errors.auth'), action: 'cookies' },
  unavailable: { category: 'parse', suggestion: t('errors.unavailable'), action: 'none' },
  geo: { category: 'parse', suggestion: t('errors.geo'), action: 'none' },
  rate_limited: { category: 'network', suggestion: t('errors.rateLimited'), action: 'retry' },
  forbidden: { category: 'unknown', suggestion: t('errors.forbidden'), action: 'engine' },
  disk_full: { category: 'storage', suggestion: t('errors.diskFull'), action: 'retry' },
  permission: { category: 'permission', suggestion: t('errors.permission'), action: 'none' },
  format: { category: 'unknown', suggestion: t('errors.format'), action: 'retry' },
  timeout: CHECK_CONNECTION,
  network: CHECK_CONNECTION,
  unsupported: LINK_UNSUPPORTED,
  not_found: LINK_UNSUPPORTED,
  checksum: { category: 'unknown', suggestion: t('errors.checksum'), action: 'retry' },
  invalid_input: { category: 'parse', suggestion: t('errors.invalidInput'), action: 'none' },
  engine_missing: { category: 'unknown', suggestion: t('errors.engineMissing'), action: 'none' },
  busy: { category: 'unknown', suggestion: t('errors.busy'), action: 'retry' },
  cancelled: { category: 'unknown', suggestion: t('errors.cancelled'), action: 'retry' },
  already_downloaded: { category: 'unknown', suggestion: t('errors.alreadyDownloaded'), action: 'none' },
};

/** Map an engine error to a category (drives auto-retry), a human suggestion
 * and the one action worth offering. Uses Rust's code when there is one;
 * otherwise pattern-matches the message (yt-dlp's English, older history). */
export function classifyError(msg: string, code?: EngineErrorCode): ClassifiedError {
  const known = code ? BY_CODE[code] : undefined;
  if (known) return known;
  const lower = msg.toLowerCase();
  // Auth / access walls (yt-dlp phrases these many ways)
  if (lower.includes('sign in to confirm') || lower.includes('not a bot') || lower.includes('login required')
    || lower.includes('private video') || lower.includes('members-only') || lower.includes('age-restricted')
    || lower.includes('age restricted') || lower.includes('confirm your age') || lower.includes('cookies'))
    return { category: 'auth', suggestion: t('errors.auth'), action: 'cookies' };
  // Gone / never existed
  if (lower.includes('video unavailable') || lower.includes('has been removed') || lower.includes('account terminated')
    || lower.includes('no longer available') || /\b404\b/.test(lower))
    return { category: 'parse', suggestion: t('errors.unavailable'), action: 'none' };
  // Region locks
  // ("…has not made this video available in your country" is yt-dlp's wording)
  if (lower.includes('available in your country') || lower.includes('geo restrict') || lower.includes('georestrict'))
    return { category: 'parse', suggestion: t('errors.geo'), action: 'none' };
  // Rate limiting — transient, but retrying immediately makes it worse
  if (lower.includes('429') || lower.includes('too many requests') || lower.includes('rate limit'))
    return { category: 'network', suggestion: t('errors.rateLimited'), action: 'retry' };
  // The site refused the request: usually extraction changed under the engine
  if (lower.includes('403') || lower.includes('forbidden'))
    return { category: 'unknown', suggestion: t('errors.forbidden'), action: 'engine' };
  if (lower.includes('permission') || lower.includes('access denied'))
    return { category: 'permission', suggestion: t('errors.permission'), action: 'none' };
  // Whole phrases: "space" matched "namespace", "full" matched "fully"
  // (REVIEW 2026-09-28 A-3).
  if (lower.includes('no space') || lower.includes('disk full') || lower.includes('disk is full') || lower.includes('not enough disk') || lower.includes('not enough space'))
    return { category: 'storage', suggestion: t('errors.diskFull'), action: 'retry' };
  if (lower.includes('codec') || lower.includes('requested format') || lower.includes('format is not available') || lower.includes('merge') || lower.includes('remux'))
    return { category: 'unknown', suggestion: t('errors.format'), action: 'retry' };
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('connection') || lower.includes('network')
    || lower.includes('dns') || lower.includes('ssl') || lower.includes('unable to download'))
    return { category: 'network', suggestion: t('errors.network'), action: 'retry' };
  if (lower.includes('not found') || lower.includes('unsupported') || lower.includes('unable to extract'))
    return { category: 'parse', suggestion: t('errors.unsupported'), action: 'none' };
  // Unknown errors must NOT classify as 'network' — that category triggers
  // automatic retries, which is wrong for failures we can't identify.
  return { category: 'unknown', suggestion: t('errors.unknown'), action: 'retry' };
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
