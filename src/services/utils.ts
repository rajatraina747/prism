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

export function formatEta(seconds: number): string {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return '--';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)}m`;
}
