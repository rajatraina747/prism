import { describe, it, expect } from 'vitest';
import { generateId, formatBytes, formatDuration, formatSpeed, formatEta, sanitizeFilename, ytdlpLiteral, isSameFolder, formatReleaseNotes, isTorrentUrl, isDirectFileUrl, directFileName, torrentDisplayName, sourceKey, siteKey, mixVideoUrl } from '../utils';

describe('sanitizeFilename', () => {
  it('passes ordinary titles through', () => {
    expect(sanitizeFilename('My Holiday Video 2026')).toBe('My Holiday Video 2026');
  });

  it('replaces path separators', () => {
    expect(sanitizeFilename('a/b\\c')).toBe('a-b-c');
    expect(sanitizeFilename('../../etc/passwd')).toBe('..-..-etc-passwd');
  });

  // Regression: it used to escape `%` too, and the -o builder escaped it
  // again, so `100% Pure` downloaded as `100%% Pure.mp4`. It makes a name;
  // the yt-dlp escaping happens once, with ytdlpLiteral.
  it('leaves % alone; escaping it for yt-dlp is ytdlpLiteral\'s job', () => {
    expect(sanitizeFilename('100% Pure')).toBe('100% Pure');
    expect(ytdlpLiteral(sanitizeFilename('cool %(channel)s clip'))).toBe('cool %%(channel)s clip');
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

describe('isDirectFileUrl', () => {
  it('routes files to the direct engine', () => {
    expect(isDirectFileUrl('https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-13.5.0-amd64-netinst.iso')).toBe(true);
    expect(isDirectFileUrl('https://example.com/releases/app-2.0.0.dmg?download=1')).toBe(true);
    expect(isDirectFileUrl('https://example.com/Annual%20Report.PDF')).toBe(true);
    expect(isDirectFileUrl('http://mirror.example.org/pub/linux-6.9.tar.xz#sha')).toBe(true);
  });

  it('leaves pages, media and other schemes to yt-dlp or the torrent engine', () => {
    expect(isDirectFileUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
    expect(isDirectFileUrl('https://example.com/video.mp4')).toBe(false);
    expect(isDirectFileUrl('https://example.com/downloads/')).toBe(false);
    expect(isDirectFileUrl('https://example.com/file.torrent')).toBe(false);
    expect(isDirectFileUrl('ftp://example.com/file.zip')).toBe(false);
    expect(isDirectFileUrl('magnet:?xt=urn:btih:abc')).toBe(false);
    expect(isDirectFileUrl('not a url.zip')).toBe(false);
  });

  it('names the file from the path', () => {
    expect(directFileName('https://example.com/a/My%20Setup.exe?x=1')).toBe('My Setup.exe');
    expect(directFileName('https://example.com/')).toBe('download');
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

describe('sourceKey (dedupe)', () => {
  it('keys magnets by info-hash, ignoring trackers/display name', () => {
    const a = 'magnet:?xt=urn:btih:ABCDEF123&dn=Ubuntu&tr=udp://x';
    const b = 'magnet:?xt=urn:btih:abcdef123&dn=Different&tr=udp://y';
    expect(sourceKey(a)).toBe('btih:abcdef123');
    expect(sourceKey(a)).toBe(sourceKey(b));
  });

  it('keys plain URLs by the trimmed URL', () => {
    expect(sourceKey('  https://vimeo.com/12345  ')).toBe('https://vimeo.com/12345');
    expect(sourceKey('https://a.com/x')).not.toBe(sourceKey('https://a.com/y'));
  });

  it('normalizes YouTube video URL variants to the same key', () => {
    const key = sourceKey('https://www.youtube.com/watch?v=abc123');
    expect(key).toBe('yt:abc123');
    expect(sourceKey('https://youtu.be/abc123')).toBe(key);
    expect(sourceKey('https://m.youtube.com/watch?v=abc123&list=PLx')).toBe(key);
    expect(sourceKey('https://www.youtube.com/shorts/abc123')).toBe(key);
    expect(sourceKey('https://youtube.com/watch?v=other')).not.toBe(key);
  });
});

describe('siteKey (per-site preset memory)', () => {
  it('normalizes URLs and bare hosts to the same key', () => {
    expect(siteKey('https://www.youtube.com/watch?v=x')).toBe('youtube.com');
    expect(siteKey('youtube.com')).toBe('youtube.com');
    expect(siteKey('www.youtube.com')).toBe('youtube.com');
    expect(siteKey('m.youtube.com')).toBe('youtube.com');
  });

  it('returns null for magnets and junk', () => {
    expect(siteKey('magnet:?xt=urn:btih:abc')).toBeNull();
    expect(siteKey('not a url')).toBeNull();
    expect(siteKey('')).toBeNull();
  });
});

// Regression (REVIEW 2026-09-23 B-10): yt-dlp expands `%` in `-o`, so a
// folder with one in its name broke every download into it.
describe('ytdlpLiteral', () => {
  it('escapes every percent sign', () => {
    expect(ytdlpLiteral('/Users/r/100% Music')).toBe('/Users/r/100%% Music');
    expect(ytdlpLiteral('/plain/path')).toBe('/plain/path');
  });
});

describe('isSameFolder', () => {
  it('matches the download folder however it is written', () => {
    expect(isSameFolder('/Users/r/Downloads/Prism', '~/Downloads/Prism')).toBe(true);
    expect(isSameFolder('/Users/r/Downloads/Prism/', '/Users/r/Downloads/Prism')).toBe(true);
    expect(isSameFolder('/Users/r/Downloads', '~/Downloads/Prism')).toBe(false);
    expect(isSameFolder('/Users/r/Downloads/Prism Extra', '~/Downloads/Prism')).toBe(false);
    expect(isSameFolder('/x', '')).toBe(false);
  });
});

describe('mixVideoUrl', () => {
  it('turns a video inside a YouTube Mix into the video alone', () => {
    expect(mixVideoUrl('https://www.youtube.com/watch?v=abc123&list=RDabc123&start_radio=1')).toBe('https://www.youtube.com/watch?v=abc123');
    expect(mixVideoUrl('https://music.youtube.com/watch?v=x1&list=RDAMVMx1')).toBe('https://www.youtube.com/watch?v=x1');
  });

  it('leaves real playlists and other sites alone', () => {
    expect(mixVideoUrl('https://www.youtube.com/watch?v=abc&list=PL123')).toBeNull();
    expect(mixVideoUrl('https://www.youtube.com/playlist?list=RD123')).toBeNull();
    expect(mixVideoUrl('https://vimeo.com/1?list=RD1&v=2')).toBeNull();
    expect(mixVideoUrl('not a url')).toBeNull();
  });
});
