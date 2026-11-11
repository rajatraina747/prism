import { describe, expect, it } from 'vitest';
import { AUDIO_QUALITIES, audioExtension, audioHint, audioQualityLabel, isAudioQuality, sourceLabel } from '@/lib/audio-quality';

describe('audio quality', () => {
  it('labels every choice from the catalog', () => {
    for (const q of AUDIO_QUALITIES) expect(audioQualityLabel(q)).not.toMatch(/^audio\./);
    expect(audioQualityLabel('mp3-320')).toBe('MP3 · 320 kbps');
    expect(audioQualityLabel('original')).toBe('Original (no conversion)');
  });

  it('accepts only the names Rust accepts', () => {
    expect(isAudioQuality('mp3-192')).toBe(true);
    expect(isAudioQuality('mp3-999')).toBe(false);
    expect(isAudioQuality('flac')).toBe(false);
  });

  it('knows the file extension, including for the original stream', () => {
    expect(audioExtension('mp3-v0')).toBe('mp3');
    expect(audioExtension('opus')).toBe('opus');
    expect(audioExtension('original', { codec: 'Opus', kbps: 160 })).toBe('opus');
    expect(audioExtension('original', { codec: 'AAC' })).toBe('m4a');
    expect(audioExtension('original')).toBe('audio');
  });

  it('shows the source, with or without a bitrate', () => {
    expect(sourceLabel({ codec: 'Opus', kbps: 160 })).toBe('Source: Opus 160 kbps');
    expect(sourceLabel({ codec: 'AAC' })).toBe('Source: AAC');
    expect(sourceLabel(undefined)).toBeNull();
  });

  it('warns when a fixed bitrate is well above the source', () => {
    const src = { codec: 'AAC', kbps: 129 };
    expect(audioHint('mp3-320', src)).toBe('Bigger file, same sound: the source is only 129 kbps.');
    expect(audioHint('mp3-128', src)).toMatch(/^Converted/);
    expect(audioHint('mp3-320')).toMatch(/^Converted/);
    expect(audioHint('original', src)).toMatch(/^Keeps the site's own audio/);
  });
});
