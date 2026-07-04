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
// separators (escaping the destination dir) or yt-dlp %(...)s template
// sequences (expanded by yt-dlp when building the output path).
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[/\\]/g, '-')
    .replace(/%/g, '%%')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '')
    .trim();
  return cleaned || 'video';
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

/** A magnet link or an http(s) URL pointing at a .torrent file — handled by the
 * torrent engine (librqbit) rather than yt-dlp. */
export function isTorrentUrl(url: string): boolean {
  const trimmed = url.trim();
  if (/^magnet:\?/i.test(trimmed)) return true;
  try {
    const u = new URL(trimmed);
    return (u.protocol === 'http:' || u.protocol === 'https:') && /\.torrent$/i.test(u.pathname);
  } catch {
    return false;
  }
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
