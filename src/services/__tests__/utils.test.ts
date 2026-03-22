import { describe, it, expect } from 'vitest';
import { generateId, formatBytes, formatDuration, formatSpeed, formatEta } from '../utils';

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
