// What the Dashboard's add paths are built from: turning a link, a list
// entry or a quality into a queue item.
import type { DefaultQuality, DownloadItem, FormatOption, PlaylistEntry } from '@/types/models';
import { isTorrentUrl, isDirectFileUrl, directFileName, torrentDisplayName, siteKey, sanitizeFilename } from '@/services';
import { referrerFor } from '@/lib/referrers';
import { buildItem, linkMetadata } from '@/stores/build-item';

/** Lookups a pasted batch runs at once (the backend allows six). */
export const BATCH_LOOKUPS = 4;

/** The option a quality means for one video: the exact resolution, else the
 * best below it, else the best there is. Options are sorted best first. */
export function pickFormatForQuality(formats: FormatOption[], quality: DefaultQuality): FormatOption | undefined {
  if (quality === 'best') return formats[0];
  const cap = parseInt(quality, 10);
  const sdr = formats.filter(f => !f.hdr);
  return sdr.find(f => f.resolution === quality)
    ?? sdr.find(f => parseInt(f.resolution, 10) <= cap)
    ?? formats[0];
}

/** A format for a quality without a per-video list (playlists): the id
 * mirrors the backend's H.264/AAC-first chain, capped at that height. 'best'
 * returns null (the backend's default is the best available). */
export function qualityToFormat(quality: DefaultQuality): FormatOption | null {
  if (quality === 'best') return null;
  const h = parseInt(quality, 10);
  return {
    id: `bestvideo[height<=${h}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=${h}][vcodec^=avc1]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`,
    label: `${quality} · H.264 when available`,
    resolution: quality,
    container: 'mp4',
    codec: 'H.264',
    fileSize: 0,
    quality: h >= 2160 ? 'best' : h >= 1080 ? 'high' : h >= 720 ? 'medium' : 'low',
  };
}

/** Whether a link goes to yt-dlp, so video or audio and quality mean anything. */
export function mayBeVideo(url: string): boolean {
  return !isTorrentUrl(url) && !isDirectFileUrl(url);
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
  audioOnly = false,
): DownloadItem {
  return buildItem({
    metadata: linkMetadata(entry.url, entry.title, siteKey(entry.url) ?? 'unknown', { duration: entry.duration, thumbnail: entry.thumbnail }),
    settings: { format: audioOnly ? null : format, destination, filename: sanitizeFilename(entry.title), speedLimit, audioOnly: audioOnly || undefined },
  });
}

