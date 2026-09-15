import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from '../Dashboard';
import { StaticServiceProvider } from '@/services/ServiceProvider';
import { AppProvider } from '@/stores/AppProvider';
import { MockPrismService } from '@/services/mock';
import { pushDeepLink } from '@/lib/deep-link-bus';

const URL_FROM_WEB = 'https://example.com/watch/123';

function renderDashboard() {
  const service = new MockPrismService();
  const parseUrl = vi.spyOn(service, 'parseUrl');
  render(
    <MemoryRouter initialEntries={['/']}>
      <StaticServiceProvider service={service}>
        <AppProvider>
          <Dashboard />
        </AppProvider>
      </StaticServiceProvider>
    </MemoryRouter>
  );
  return { parseUrl };
}

/** S-6: a web page can open prism:// and magnet: links without the user's
 * intent, and parsing already reaches the network — so nothing is parsed
 * until the user says so. */
describe('Dashboard links from outside the app', () => {
  it('asks before fetching, and fetches on Add', async () => {
    const { parseUrl } = renderDashboard();
    act(() => pushDeepLink(URL_FROM_WEB, 'external'));

    expect(await screen.findByText('Download from this link?')).toBeInTheDocument();
    expect(screen.getByText(URL_FROM_WEB)).toBeInTheDocument();
    expect(parseUrl).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(parseUrl).toHaveBeenCalledWith(URL_FROM_WEB));
  });

  it('never fetches an ignored link', async () => {
    const { parseUrl } = renderDashboard();
    act(() => pushDeepLink('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567', 'external'));

    expect(await screen.findByText('Add this torrent?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ignore' }));

    await waitFor(() => expect(screen.queryByText('Add this torrent?')).not.toBeInTheDocument());
    expect(parseUrl).not.toHaveBeenCalled();
  });

  it('adds in-app links (tray paste, drops) without asking', async () => {
    const { parseUrl } = renderDashboard();
    act(() => pushDeepLink(URL_FROM_WEB, 'app'));

    await waitFor(() => expect(parseUrl).toHaveBeenCalledWith(URL_FROM_WEB));
    expect(screen.queryByText('Download from this link?')).not.toBeInTheDocument();
  });
});
