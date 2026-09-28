import { describe, it, expect } from 'vitest';
import { buildItem, linkMetadata } from '../build-item';

// REVIEW 2026-09-28 A-2: one way to make a queue item.
describe('buildItem', () => {
  const metadata = linkMetadata('https://example.com/v', 'A video', 'example.com');

  it('makes a queued item with no size guess and no dead retryCount', () => {
    const item = buildItem({ metadata, settings: { format: null, destination: '~/dl', filename: 'A video' } });
    expect(item.status).toBe('queued');
    expect(item.totalBytes).toBe(0);
    expect(item.settings.startImmediately).toBe(true);
    expect('retryCount' in item.settings).toBe(false);
    expect('kind' in item).toBe(false);
  });

  it('holds an item added with Start immediately off, and keeps a known size', () => {
    const item = buildItem({ kind: 'direct', metadata, settings: { format: null, destination: '~/dl', filename: 'x', startImmediately: false }, totalBytes: 1234 });
    expect(item.status).toBe('ready');
    expect(item.totalBytes).toBe(1234);
    expect(item.kind).toBe('direct');
  });

  it('gives every item its own id', () => {
    const settings = { format: null, destination: '~/dl', filename: 'x' };
    expect(buildItem({ metadata, settings }).id).not.toBe(buildItem({ metadata, settings }).id);
  });
});
