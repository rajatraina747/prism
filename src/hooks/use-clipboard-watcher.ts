import { useEffect, useRef } from 'react';
import { useService } from '@/services/ServiceProvider';

const VIDEO_HOSTS = [
  'youtube.com', 'youtu.be', 'vimeo.com', 'tiktok.com', 'instagram.com',
  'twitter.com', 'x.com', 'twitch.tv', 'dailymotion.com', 'soundcloud.com',
  'reddit.com', 'facebook.com', 'fb.watch',
];

function isVideoUrl(text: string): boolean {
  if (text.length > 2048 || /\s/.test(text)) return false;
  try {
    const u = new URL(text);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.replace(/^www\./, '');
    return VIDEO_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

// Survives remounts so navigating back to the Dashboard doesn't re-offer the
// same URL — and relaunches too: kept in module memory only, the same link was
// offered again on every start (Windows test run 2026-09-26). Storage can be
// unavailable, so every access is guarded; memory alone is the fallback.
//
// Only a fingerprint is kept, never the text: the watcher reads whatever was
// copied — a password, a token — and it used to sit in the webview's storage
// on disk (REVIEW 2026-09-28 S-4).
const LAST_SEEN_KEY = 'prism.clipboard.lastSeen';

/** A short, one-way fingerprint (FNV-1a, 53 bits). Enough to tell "the same
 * text as last time" apart; nothing to read back. */
export function clipboardFingerprint(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return 'fp:' + (((h2 >>> 0) & 0x1fffff) * 0x100000000 + (h1 >>> 0)).toString(36);
}

let lastSeen = (() => {
  try {
    const stored = localStorage.getItem(LAST_SEEN_KEY) ?? '';
    if (stored && !stored.startsWith('fp:')) {
      // Written by an older version: the clipboard text itself. Replace it.
      const fp = clipboardFingerprint(stored);
      localStorage.setItem(LAST_SEEN_KEY, fp);
      return fp;
    }
    return stored;
  } catch { return ''; }
})();
function remember(fingerprint: string) {
  lastSeen = fingerprint;
  try { localStorage.setItem(LAST_SEEN_KEY, fingerprint); } catch { /* memory only */ }
}

/**
 * Watch the clipboard for video URLs whenever the window regains focus
 * (and once on mount), calling onUrl for each new one detected.
 */
export function useClipboardWatcher(onUrl: (url: string) => void, enabled = true) {
  const service = useService();
  const onUrlRef = useRef(onUrl);
  onUrlRef.current = onUrl;

  useEffect(() => {
    if (!enabled) return;
    const check = async () => {
      try {
        const text = (await service.readClipboard()).trim();
        const fp = text && clipboardFingerprint(text);
        if (!fp || fp === lastSeen) return;
        remember(fp);
        if (isVideoUrl(text)) onUrlRef.current(text);
      } catch { /* clipboard unavailable */ }
    };
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [enabled, service]);
}
