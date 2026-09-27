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
const LAST_SEEN_KEY = 'prism.clipboard.lastSeen';
let lastSeen = (() => {
  try { return localStorage.getItem(LAST_SEEN_KEY) ?? ''; } catch { return ''; }
})();
function remember(text: string) {
  lastSeen = text;
  try { localStorage.setItem(LAST_SEEN_KEY, text); } catch { /* memory only */ }
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
        if (!text || text === lastSeen) return;
        remember(text);
        if (isVideoUrl(text)) onUrlRef.current(text);
      } catch { /* clipboard unavailable */ }
    };
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [enabled, service]);
}
