import { describe, expect, it } from 'vitest';
import { pickFormatForQuality, qualityToFormat } from './add-items';
import { qualityFromStored, type FormatOption } from '@/types/models';

const opt = (resolution: string, hdr = false): FormatOption => ({
  id: resolution + (hdr ? '-hdr' : ''), label: resolution, resolution, container: 'mp4',
  codec: 'H.264', fileSize: 0, quality: 'high', hdr,
});
// As formats.rs sorts them: best first, SDR before HDR.
const formats = [opt('2160p'), opt('2160p', true), opt('1080p'), opt('720p'), opt('480p')];

describe('default quality', () => {
  it('picks the exact resolution, never the HDR twin', () => {
    expect(pickFormatForQuality(formats, '2160p')?.id).toBe('2160p');
    expect(pickFormatForQuality(formats, '720p')?.id).toBe('720p');
  });

  it('falls to the best below when the video has no such size', () => {
    expect(pickFormatForQuality(formats, '1440p')?.id).toBe('1080p');
    expect(pickFormatForQuality([opt('360p')], '1080p')?.id).toBe('360p');
  });

  it('best is the first option, and has no synthesized format', () => {
    expect(pickFormatForQuality(formats, 'best')?.id).toBe('2160p');
    expect(qualityToFormat('best')).toBeNull();
    expect(qualityToFormat('720p')?.id).toContain('height<=720');
  });

  it('reads pre-2.4 per-site preset ids', () => {
    expect(qualityFromStored('4k')).toBe('2160p');
    expect(qualityFromStored('compact')).toBe('480p');
    expect(qualityFromStored('compatible')).toBe('1080p');
    expect(qualityFromStored('720p')).toBe('720p');
    expect(qualityFromStored('360p')).toBeUndefined();
    expect(qualityFromStored(undefined)).toBeUndefined();
  });
});
