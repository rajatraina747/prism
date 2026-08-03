import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AppShell } from '../layout/AppShell';
import { StaticServiceProvider } from '@/services/ServiceProvider';
import { AppProvider } from '@/stores/AppProvider';
import { MockPrismService } from '@/services/mock';

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
    fireEvent.click(screen.getByText('Queue'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/queue'));
    fireEvent.click(screen.getByText('Library'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/library'));

    expect(onDeepLink).toHaveBeenCalledTimes(1);
  });

  it('still routes an incoming link to the Dashboard from another page', async () => {
    const { onDeepLink } = await renderShell();
    await waitFor(() => expect(onDeepLink).toHaveBeenCalledTimes(1));
    const handler = onDeepLink.mock.calls[0][0];

    fireEvent.click(screen.getByText('Queue'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/queue'));

    act(() => handler('magnet:?xt=urn:btih:abc'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/'));
  });
});
