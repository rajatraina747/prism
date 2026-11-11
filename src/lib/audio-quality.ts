import { t } from '@/i18n';
import type { AudioQuality, AudioSource } from '@/types/models';

/** In the order the menus list them. Rust's `audio::AudioQuality` accepts
 * exactly these names. */
export const AUDIO_QUALITIES: AudioQuality[] = ['original', 'mp3-v0', 'mp3-320', 'mp3-256', 'mp3-192', 'mp3-128', 'm4a', 'opus'];

export function isAudioQuality(value: unknown): value is AudioQuality {
  return typeof value === 'string' && (AUDIO_QUALITIES as string[]).includes(value);
}

export function audioQualityLabel(q: AudioQuality): string {
  return t(`audio.choices.${q.replace('-', '_')}`);
}

/** The bitrate a fixed-rate MP3 is encoded at; null for the others. */
function fixedKbps(q: AudioQuality): number | null {
  const m = /^mp3-(\d+)$/.exec(q);
  return m ? Number(m[1]) : null;
}

/** The file's extension once yt-dlp is done. "Original" keeps the source's
 * codec: Opus stays .opus and AAC lands in .m4a; anything else is unknown
 * until it's downloaded. */
export function audioExtension(q: AudioQuality, source?: AudioSource): string {
  if (q === 'original') {
    if (source?.codec === 'Opus') return 'opus';
    if (source?.codec === 'AAC') return 'm4a';
    if (source?.codec === 'MP3') return 'mp3';
    return t('audio.extensionUnknown');
  }
  return q === 'm4a' || q === 'opus' ? q : 'mp3';
}

/** "Source: Opus 160 kbps", or null when the site didn't say. */
export function sourceLabel(source?: AudioSource): string | null {
  if (!source) return null;
  return source.kbps
    ? t('audio.source', { codec: source.codec, kbps: source.kbps })
    : t('audio.sourceNoRate', { codec: source.codec });
}

/** One line under the choice: what it does with this source. */
export function audioHint(q: AudioQuality, source?: AudioSource): string {
  if (q === 'original') return t('audio.hint.original');
  const kbps = fixedKbps(q);
  // A clear margin, so a 129 kbps source doesn't warn at 128.
  if (kbps && source?.kbps && kbps > source.kbps * 1.15) {
    return t('audio.hint.upsample', { kbps: source.kbps });
  }
  return t('audio.hint.convert');
}
