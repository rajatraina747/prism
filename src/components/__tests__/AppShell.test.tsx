import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AppShell } from '../layout/AppShell';
import { StaticServiceProvider } from '@/services/ServiceProvider';
import { AppProvider } from '@/stores/AppProvider';
import { MockPrismService } from '@/services/mock';
import { consumeDeepLinks } from '@/lib/deep-link-bus';

function LocationProbe() {
  return <span data-testid="loc">{useLocation().pathname}</span>;
}

async function renderShell() {
  const service = new MockPrismService();
  const onDeepLink = vi.spyOn(service, 'onDeepLink');

  render(
    <MemoryRouter initialEntries={['/']}>
      <StaticServiceProvider service={service}>
        <AppProvider>
          <AppShell><LocationProbe /></AppShell>
        </AppProvider>
      </StaticServiceProvider>
    </MemoryRouter>
  );

  return { onDeepLink };
}

describe('AppShell deep links', () => {
  it('subscribes once and keeps the subscription across navigation', async () => {
    const { onDeepLink } = await renderShell();
    await waitFor(() => expect(onDeepLink).toHaveBeenCalledTimes(1));

    // Sidebar navigation must not tear down and re-create the subscription:
    // re-subscribing re-reads the link that launched the app, which bounced
    // the user straight back to the Dashboard on Windows.
    fireEvent.click(screen.getByText('Transfers'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/queue'));
    fireEvent.click(screen.getByText('Library'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/library'));

    expect(onDeepLink).toHaveBeenCalledTimes(1);
  });

  it('still routes an incoming link to the Dashboard from another page', async () => {
    const { onDeepLink } = await renderShell();
    await waitFor(() => expect(onDeepLink).toHaveBeenCalledTimes(1));
    const handler = onDeepLink.mock.calls[0][0];

    fireEvent.click(screen.getByText('Transfers'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/queue'));

    act(() => handler('magnet:?xt=urn:btih:abc', 'external'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/'));
  });
});

describe('AppShell Add sheet', () => {
  it('opens with ⌘L from any page and adds every link together', async () => {
    await renderShell();
    // The bus is module state: drain links earlier tests left queued.
    consumeDeepLinks(() => {})();
    const received: [string[], string][] = [];
    const stop = consumeDeepLinks((urls, origin) => received.push([urls, origin]));

    fireEvent.click(screen.getByText('Library'));
    fireEvent.keyDown(window, { key: 'l', metaKey: true });
    const box = await screen.findByRole('textbox', { name: 'Links to add' });
    fireEvent.change(box, { target: { value: 'https://a.example/1\nmagnet:?xt=urn:btih:abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add 2' }));

    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/'));
    expect(received).toEqual([[['https://a.example/1', 'magnet:?xt=urn:btih:abc'], 'app']]);
    expect(screen.queryByRole('textbox', { name: 'Links to add' })).toBeNull();
    stop();
  });

  it('opens from the sidebar Add button', async () => {
    await renderShell();
    fireEvent.click(screen.getByRole('button', { name: /^Add/ }));
    expect(await screen.findByRole('dialog', { name: 'Add downloads' })).toBeTruthy();
  });
});
