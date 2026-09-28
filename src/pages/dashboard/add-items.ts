// What the Dashboard's add paths are built from: turning a link, a list
// entry or a preset into a queue item.
import type { DownloadItem, DownloadPreset, FormatOption, PlaylistEntry } from '@/types/models';
import { isTorrentUrl, directFileName, torrentDisplayName, siteKey, sanitizeFilename } from '@/services';
import { referrerFor } from '@/lib/referrers';
import { buildItem, linkMetadata } from '@/stores/build-item';

/** Lookups a pasted batch runs at once (the backend allows six). */
export const BATCH_LOOKUPS = 4;

/** Pick the format that best matches a preset's target resolution. */
export function pickFormatForPreset(formats: FormatOption[], preset: DownloadPreset): FormatOption | undefined {
  if (preset.resolution === 'Best') return formats[0]; // formats are sorted descending
  if (preset.id === 'compatible') {
    // The best option that plays everywhere, else the strict H.264 filter.
    const cap = parseInt(preset.resolution, 10);
    return formats.find(f => f.playsEverywhere !== false && !f.hdr && parseInt(f.resolution, 10) <= cap)
      ?? presetToFormat(preset) ?? undefined;
  }
  return formats.find(f => f.resolution === preset.resolution) || formats[0];
}

/** Synthesize a FormatOption for a preset without a per-video format list —
 * the id mirrors the backend's H.264/AAC-first yt-dlp filter chain, capped at
 * the preset's height. 'Best' returns null (backend default = best available). */
export function presetToFormat(preset: DownloadPreset): FormatOption | null {
  if (preset.resolution === 'Best') return null;
  const h = parseInt(preset.resolution, 10);
  if (!h) return null;
  if (preset.id === 'compatible') {
    return {
      id: `bestvideo[height<=${h}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=${h}][vcodec^=avc1]/best[height<=${h}]`,
      label: `${preset.resolution} · H.264`,
      resolution: preset.resolution,
      container: 'mp4',
      codec: 'H.264',
      fileSize: 0,
      quality: 'high',
      playsEverywhere: true,
    };
  }
  return {
    id: `bestvideo[height<=${h}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=${h}][vcodec^=avc1]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`,
    label: `${preset.resolution} · H.264 when available`,
    resolution: preset.resolution,
    container: 'mp4',
    codec: 'H.264',
    fileSize: 0,
    quality: (preset.quality as FormatOption['quality']) || 'high',
  };
}

/** Build a queue item for a direct file link. Skips yt-dlp; the engine takes
 * the real name and size from the server when it starts. */
export function buildDirectItem(url: string, destination: string, speedLimit?: number, title = directFileName(url)): DownloadItem {
  const referer = referrerFor(url);
  let domain = 'download';
  try { domain = new URL(url).hostname; } catch { /* checked by isDirectFileUrl */ }
  return buildItem({
    kind: 'direct',
    metadata: linkMetadata(url, title, domain),
    settings: { format: null, destination, filename: title, speedLimit, ...(referer ? { referer } : {}) },
  });
}

/** A YouTube watch URL that also carries a playlist: return both "just this
 * video" and "whole playlist" forms so the user can choose. Null when the URL
 * isn't ambiguous. Mix/radio pseudo-playlists (list=RD…) aren't real playlists
 * — treat those as plain videos. */
export function watchWithListInfo(url: string): { videoUrl: string; playlistUrl: string } | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
    if (host !== 'youtube.com' && host !== 'music.youtube.com') return null;
    const v = u.searchParams.get('v');
    const list = u.searchParams.get('list');
    if (!v || !list || list.startsWith('RD')) return null;
    return {
      videoUrl: `https://www.youtube.com/watch?v=${v}`,
      playlistUrl: `https://www.youtube.com/playlist?list=${list}`,
    };
  } catch {
    return null;
  }
}

/** One-line summary of a link for the confirmation card. */
export function describeExternalLink(url: string): string {
  if (isTorrentUrl(url)) return `Torrent · ${torrentDisplayName(url)}`;
  try { return new URL(url).hostname; } catch { return url; }
}

/** A queue item for one entry of a list, straight from the flat lookup
 * (title, duration and thumbnail are already known): no per-video lookup, and
 * `format` is the preset's synthesized filter, resolved when it starts. */
export function playlistEntryItem(
  entry: PlaylistEntry,
  format: FormatOption | null,
  destination: string,
  speedLimit: number | undefined,
): DownloadItem {
  return buildItem({
    metadata: linkMetadata(entry.url, entry.title, siteKey(entry.url) ?? 'unknown', { duration: entry.duration, thumbnail: entry.thumbnail }),
    settings: { format, destination, filename: sanitizeFilename(entry.title), speedLimit },
  });
}

