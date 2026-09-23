import type { DownloadKind } from '@/types/models';

export function generateId(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2, 11);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i > 1 ? 1 : 0)} ${sizes[i]}`;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

// Titles come from the remote site and are untrusted: they can contain path
// separators (escaping the destination dir). This makes a *name*; it doesn't
// escape `%` for yt-dlp, because the name is also shown, stored and used by
// the direct engine, none of which expand templates. Escaping it here as
// well as where `-o` is built wrote `100% Pure` as `100%% Pure.mp4`. yt-dlp's
// `-o` is escaped once, with ytdlpLiteral, where it is built.
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[/\\]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '')
    .trim();
  return cleaned || 'video';
}

// Whether a picked folder (absolute) is a folder from settings, which may be
// written with a leading `~`. The frontend doesn't know the home folder, so a
// `~/…` setting matches any absolute path ending in the same components.
export function isSameFolder(picked: string, setting: string): boolean {
  const trim = (p: string) => p.trim().replace(/[\\/]+$/, '');
  const a = trim(picked);
  const b = trim(setting);
  if (!a || !b) return false;
  if (a === b) return true;
  return b.startsWith('~/') && a.endsWith(b.slice(1));
}

// A folder path as yt-dlp's `-o` should see it: `%` starts a template field
// there, so a literal one is written `%%`. A destination such as
// `~/100% Music` otherwise broke every download into it (REVIEW 2026-09-23
// B-10).
export function ytdlpLiteral(path: string): string {
  return path.replace(/%/g, '%%');
}

// Updater release notes arrive as GitHub-flavored markdown but are shown as
// plain text in Settings. Strip the markup and drop the "## Install" section,
// which is noise when you're updating from inside the app.
export function formatReleaseNotes(raw: string): string {
  const beforeInstall = raw.split(/^##\s*Install\s*$/m)[0];
  return beforeInstall
    .replace(/^#{1,6}\s*(.+)$/gm, '$1') // headers → plain lines
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/`([^`]+)`/g, '$1') // inline code
    .trim();
}

export function formatEta(seconds: number): string {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return '--';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)}m`;
}

/** Extract the video URL from a `prism://add?url=...` deep link. Anything that
 * isn't exactly that shape — another scheme, another action, a non-http(s)
 * target — yields null. Pure, so it's unit-tested without the Tauri mocks. */
export function parsePrismDeepLink(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'prism:') return null;
    // Accept both prism://add?url=... (host) and prism:/add?url=... (path)
    const action = u.hostname || u.pathname.replace(/^\/+/, '');
    if (action !== 'add') return null;
    const target = u.searchParams.get('url');
    if (!target) return null;
    const t = new URL(target);
    return (t.protocol === 'http:' || t.protocol === 'https:') ? target : null;
  } catch {
    return null;
  }
}

/** A magnet link, or a .torrent file (http(s) URL, file:// URL, or local path) —
 * handled by the torrent engine (librqbit) rather than yt-dlp. */
export function isTorrentUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/^magnet:\?/i.test(trimmed)) return true;
  // Ends in .torrent, ignoring any query string. Covers https://…/x.torrent,
  // file:///…/x.torrent, and bare paths like /Users/me/x.torrent.
  const pathPart = trimmed.split(/[?#]/)[0];
  return /\.torrent$/i.test(pathPart);
}

/** File types that are downloaded as they are, by the direct-link engine,
 * rather than through yt-dlp: disk images, archives, installers, documents.
 * Video and audio files stay with yt-dlp, which adds metadata and thumbnails. */
const DIRECT_FILE_RE = /\.(iso|img|dmg|pkg|zip|7z|rar|tar|gz|tgz|bz2|tbz2|xz|txz|zst|exe|msi|msix|appimage|deb|rpm|apk|pdf|epub|mobi|azw3|cbz|cbr|djvu|docx?|xlsx?|pptx?|odt|ods|odp|csv|bin)$/i;

/** An http(s) link straight to a file Prism should fetch as-is. */
export function isDirectFileUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return DIRECT_FILE_RE.test(decodeURIComponent(u.pathname));
  } catch {
    return false;
  }
}

/** Which engine a link belongs to.
 *
 * Composed from the two predicates above rather than re-deriving the rules, so
 * a magnet arriving in an RSS enclosure is classified exactly the way the same
 * magnet pasted into the Dashboard is. A second, subtly different rule here is
 * how feeds would start behaving differently from hand-added links. */
export function classifyLink(url: string): DownloadKind {
  if (isTorrentUrl(url)) return 'torrent';
  if (isDirectFileUrl(url)) return 'direct';
  return 'http';
}

/** File name a direct link points at, for the queue until the server names it. */
export function directFileName(url: string): string {
  try {
    const last = new URL(url.trim()).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : 'download';
  } catch {
    return 'download';
  }
}

/** Canonical per-site key (hostname without www./m.) for preset memory.
 * Accepts a full URL or a bare hostname; null when neither parses to a host. */
export function siteKey(urlOrHost: string): string | null {
  let host = urlOrHost.trim();
  try { host = new URL(host).hostname; } catch { /* already a bare hostname */ }
  host = host.toLowerCase().replace(/^(www|m)\./, '');
  // A bare hostname has no slashes/spaces and at least one dot.
  if (!host || /[/\s]/.test(host) || !host.includes('.')) return null;
  return host;
}

/** Canonical key for de-duplicating a source: a magnet's info-hash (so the same
 * torrent matches regardless of trackers/display-name), a YouTube video id (so
 * youtu.be/ID, watch?v=ID, and shorts/ID all match), else the trimmed URL. */
export function sourceKey(url: string): string {
  const trimmed = url.trim();
  const m = trimmed.match(/xt=urn:btih:([a-z0-9]+)/i);
  if (m) return `btih:${m[1].toLowerCase()}`;
  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      if (id) return `yt:${id}`;
    }
    if (host === 'youtube.com' || host === 'music.youtube.com') {
      const v = u.searchParams.get('v');
      if (v) return `yt:${v}`;
      const parts = u.pathname.split('/').filter(Boolean);
      if ((parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed') && parts[1]) {
        return `yt:${parts[1]}`;
      }
    }
  } catch { /* not a URL — fall through to the raw string */ }
  return trimmed;
}

/** Best-effort human title for a torrent source: the magnet `dn` (display name)
 * or the `.torrent` filename, falling back to a generic label. */
export function torrentDisplayName(url: string): string {
  const trimmed = url.trim();
  try {
    if (/^magnet:\?/i.test(trimmed)) {
      const dn = new URL(trimmed).searchParams.get('dn');
      if (dn) return decodeURIComponent(dn);
    } else {
      const name = new URL(trimmed).pathname.split('/').pop();
      if (name) return decodeURIComponent(name.replace(/\.torrent$/i, ''));
    }
  } catch {
    /* fall through */
  }
  return 'Torrent download';
}
