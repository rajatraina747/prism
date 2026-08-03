import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OutboundLink } from '../common';
import { StaticServiceProvider } from '@/services/ServiceProvider';
import { MockPrismService } from '@/services/mock';
import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

// A plain <a target="_blank"> is inert inside the Tauri webview, so the click
// has to be handed to the OS browser instead of the default navigation.

function renderLink(href = 'https://www.rainacorp.co.uk') {
  const service = new MockPrismService();
  const openExternal = vi.spyOn(service, 'openExternal').mockResolvedValue();
  render(
    <StaticServiceProvider service={service}>
      <OutboundLink href={href}>RainaCorp</OutboundLink>
    </StaticServiceProvider>
  );
  return { openExternal, link: screen.getByText('RainaCorp') };
}

describe('OutboundLink', () => {
  it('routes the click to the OS browser instead of navigating', () => {
    const { openExternal, link } = renderLink();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    expect(openExternal).toHaveBeenCalledWith('https://www.rainacorp.co.uk');
    expect(event.defaultPrevented).toBe(true);
  });

  it('keeps the real href and safe rel for the web build', () => {
    const { link } = renderLink('https://github.com/rajatraina747/prism/releases');
    expect(link.getAttribute('href')).toBe('https://github.com/rajatraina747/prism/releases');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('tells the user when the link cannot be opened', async () => {
    const service = new MockPrismService();
    vi.spyOn(service, 'openExternal').mockRejectedValue(new Error('no browser'));
    render(
      <StaticServiceProvider service={service}>
        <OutboundLink href="https://example.com">x</OutboundLink>
      </StaticServiceProvider>
    );

    fireEvent.click(screen.getByText('x'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't open that link"));
  });
});
