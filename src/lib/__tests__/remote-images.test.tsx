import { describe, it, expect, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { act } from 'react';
import { Thumb } from '@/components/common';
import { setRemoteImagesAllowed } from '../remote-images';

// Regression (REVIEW 2026-09-26 M6): with a proxy set the page must not fetch
// thumbnails itself — that request would bypass the proxy.
describe('remote thumbnails', () => {
  afterEach(() => setRemoteImagesAllowed(true));

  it('loads a remote thumbnail normally, and shows the tile instead while not allowed', () => {
    const { container } = render(<Thumb src="https://i.ytimg.com/vi/x/hq.jpg" className="w-8 h-8" />);
    expect(container.querySelector('img')).not.toBeNull();
    act(() => setRemoteImagesAllowed(false));
    expect(container.querySelector('img')).toBeNull();
  });

  it('still shows pictures that are not fetched from the internet', () => {
    setRemoteImagesAllowed(false);
    const { container } = render(<Thumb src="data:image/png;base64,AAAA" className="w-8 h-8" />);
    expect(container.querySelector('img')).not.toBeNull();
  });
});
