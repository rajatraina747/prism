import { describe, it, expect } from 'vitest';
import { generateId, formatBytes, formatDuration, formatSpeed, formatEta, sanitizeFilename, formatReleaseNotes, isTorrentUrl, torrentDisplayName } from '../utils';

describe('sanitizeFilename', () => {
  it('passes ordinary titles through', () => {
    expect(sanitizeFilename('My Holiday Video 2026')).toBe('My Holiday Video 2026');
  });

  it('replaces path separators', () => {
    expect(sanitizeFilename('a/b\\c')).toBe('a-b-c');
    expect(sanitizeFilename('../../etc/passwd')).toBe('..-..-etc-passwd');
  });

  it('escapes yt-dlp template sequences', () => {
    expect(sanitizeFilename('cool %(channel)s clip')).toBe('cool %%(channel)s clip');
  });

  it('strips control characters and trims', () => {
    expect(sanitizeFilename('  hi\x00\x1fthere  ')).toBe('hithere');
  });

  it('falls back for empty or fully-stripped input', () => {
    expect(sanitizeFilename('')).toBe('video');
    expect(sanitizeFilename('  \x01  ')).toBe('video');
  });
});

describe('generateId', () => {
  it('returns a non-empty string', () => {
    expect(generateId()).toBeTruthy();
    expect(typeof generateId()).toBe('string');
  });

  it('returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe('formatBytes', () => {
  it('formats 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('2 KB');
  });

  it('formats megabytes with one decimal', () => {
    expect(formatBytes(1_048_576)).toBe('1.0 MB');
    expect(formatBytes(5_500_000)).toBe('5.2 MB');
  });

  it('formats gigabytes with one decimal', () => {
    expect(formatBytes(1_073_741_824)).toBe('1.0 GB');
    expect(formatBytes(2_500_000_000)).toBe('2.3 GB');
  });
});

describe('formatDuration', () => {
  it('formats seconds only', () => {
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(45)).toBe('0:45');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(600)).toBe('10:00');
  });

  it('formats hours, minutes, and seconds', () => {
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(7200)).toBe('2:00:00');
  });

  it('handles zero', () => {
    expect(formatDuration(0)).toBe('0:00');
  });
});

describe('formatSpeed', () => {
  it('formats speed with /s suffix', () => {
    expect(formatSpeed(1_048_576)).toBe('1.0 MB/s');
    expect(formatSpeed(0)).toBe('0 B/s');
  });
});

describe('formatEta', () => {
  it('returns -- for zero or negative', () => {
    expect(formatEta(0)).toBe('--');
    expect(formatEta(-1)).toBe('--');
  });

  it('returns -- for Infinity', () => {
    expect(formatEta(Infinity)).toBe('--');
  });

  it('formats seconds', () => {
    expect(formatEta(30)).toBe('30s');
    expect(formatEta(1)).toBe('1s');
  });

  it('formats minutes', () => {
    expect(formatEta(90)).toBe('2m');
    expect(formatEta(300)).toBe('5m');
  });

  it('formats hours and minutes', () => {
    expect(formatEta(3700)).toBe('1h 2m');
    expect(formatEta(7200)).toBe('2h 0m');
  });
});

describe('formatReleaseNotes', () => {
  it('strips markdown and drops the Install section', () => {
    const raw = [
      '## What\'s New',
      '',
      '- **Menu bar quick-add** — paste from `clipboard`',
      '- **Linux support** — AppImage, deb, rpm',
      '',
      '## Install',
      '',
      '**macOS**: Download the `.dmg` file.',
    ].join('\n');
    const out = formatReleaseNotes(raw);
    expect(out).toContain("What's New");
    expect(out).toContain('Menu bar quick-add — paste from clipboard');
    expect(out).not.toContain('**');
    expect(out).not.toContain('`');
    expect(out).not.toContain('Install');
    expect(out).not.toContain('.dmg');
  });
});

describe('isTorrentUrl', () => {
  it('matches magnet links', () => {
    expect(isTorrentUrl('magnet:?xt=urn:btih:abc123&dn=Ubuntu')).toBe(true);
    expect(isTorrentUrl('  MAGNET:?xt=urn:btih:abc  ')).toBe(true);
  });

  it('matches .torrent files across schemes and bare paths', () => {
    expect(isTorrentUrl('https://example.com/files/debian.iso.torrent')).toBe(true);
    expect(isTorrentUrl('http://x.org/a.torrent')).toBe(true);
    expect(isTorrentUrl('http://x.org/a.torrent?token=1')).toBe(true);
    expect(isTorrentUrl('file:///Users/me/Downloads/ubuntu.torrent')).toBe(true);
    expect(isTorrentUrl('/Users/me/Downloads/ubuntu.torrent')).toBe(true);
  });

  it('rejects ordinary video URLs and junk', () => {
    expect(isTorrentUrl('https://youtube.com/watch?v=abc')).toBe(false);
    expect(isTorrentUrl('https://example.com/torrent-guide')).toBe(false);
    expect(isTorrentUrl('not a url')).toBe(false);
    expect(isTorrentUrl('')).toBe(false);
  });
});

describe('torrentDisplayName', () => {
  it('uses the magnet display name', () => {
    expect(torrentDisplayName('magnet:?xt=urn:btih:abc&dn=Debian%2013')).toBe('Debian 13');
  });

  it('uses the .torrent filename', () => {
    expect(torrentDisplayName('https://x.org/path/ubuntu-24.04.torrent')).toBe('ubuntu-24.04');
  });

  it('falls back for magnets without dn', () => {
    expect(torrentDisplayName('magnet:?xt=urn:btih:abc')).toBe('Torrent download');
  });
});
