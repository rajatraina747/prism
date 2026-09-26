import { describe, it, expect, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { Thumb } from '@/components/common';
import { setThumbResolver } from '../thumb-cache';
import { setRemoteImagesAllowed } from '../remote-images';

afterEach(() => { setThumbResolver(null); setRemoteImagesAllowed(true); });

describe('cached thumbnails', () => {
  it('shows the local copy when there is one', async () => {
    setThumbResolver(async url => `asset://local/${encodeURIComponent(url)}`);
    const { container } = render(<Thumb src="https://i.ytimg.com/vi/a/hq.jpg" />);
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toContain('asset://local/'));
  });

  // Regression (REVIEW 2026-09-26 M6): with a proxy set, thumbnails were
  // simply not shown; the local copy is fetched through the proxy.
  it('shows the local copy even with a proxy set', async () => {
    setRemoteImagesAllowed(false);
    setThumbResolver(async () => 'asset://local/x.jpg');
    const { container } = render(<Thumb src="https://i.ytimg.com/vi/b/hq.jpg" />);
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('asset://local/x.jpg'));
  });

  it('falls back to the remote picture when the copy fails, unless a proxy forbids it', async () => {
    setThumbResolver(async () => { throw new Error('offline'); });
    const { container } = render(<Thumb src="https://i.ytimg.com/vi/c/hq.jpg" />);
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('https://i.ytimg.com/vi/c/hq.jpg'));
  });
});
