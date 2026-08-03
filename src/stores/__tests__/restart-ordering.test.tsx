import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { AppProvider, useQueue } from '../AppProvider';
import { StaticServiceProvider } from '@/services/ServiceProvider';
import { MockPrismService } from '@/services/mock';
import type { DownloadItem } from '@/types/models';

// A pause kills the backend process asynchronously. If the item is resumed
// before that kill lands, the backend would kill the *replacement* process and
// leave the item 'downloading' with nothing behind it — so the restart has to
// wait for the kill to come back.

function makeItem(id: string, status: DownloadItem['status'] = 'queued'): DownloadItem {
  return {
    id,
    metadata: {
      title: `Video ${id}`,
      duration: 60,
      thumbnail: '',
      source: { url: 'https://example.com', domain: 'example.com', addedAt: '' },
      formats: [],
    },
    settings: { format: null, destination: '/downloads', filename: 'test', retryCount: 3, startImmediately: false },
    status,
    progress: 0,
    speed: 0,
    eta: 0,
    downloadedBytes: 0,
    totalBytes: 100_000,
    retryAttempt: 0,
  };
}

function QueueHelper({ onReady }: { onReady: (a: ReturnType<typeof useQueue>) => void }) {
  onReady(useQueue());
  return null;
}

beforeEach(() => { localStorage.clear(); });

describe('pause → resume before the kill lands', () => {
  it('holds the restart until cancelDownload settles', async () => {
    const service = new MockPrismService();
    const startDownload = vi.spyOn(service, 'startDownload').mockReturnValue(() => {});
    let releaseCancel!: () => void;
    vi.spyOn(service, 'cancelDownload').mockImplementation(
      () => new Promise<void>(resolve => { releaseCancel = () => resolve(); }),
    );

    let q: ReturnType<typeof useQueue> | null = null;
    await act(async () => {
      render(
        <StaticServiceProvider service={service}>
          <AppProvider><QueueHelper onReady={a => { q = a; }} /></AppProvider>
        </StaticServiceProvider>
      );
    });
    await waitFor(() => expect(q).not.toBeNull());

    // Start it, then pause — the kill is now in flight.
    await act(async () => { q!.addToQueue(makeItem('x')); });
    await waitFor(() => expect(startDownload).toHaveBeenCalledTimes(1));
    await act(async () => { q!.pauseDownload('x'); });
    expect(q!.items[0].status).toBe('paused');

    // Resume while the kill is still outstanding: no second process yet.
    await act(async () => { q!.resumeDownload('x'); });
    expect(startDownload).toHaveBeenCalledTimes(1);
    expect(q!.items[0].status).toBe('queued');

    // Kill lands — now the item starts again.
    await act(async () => { releaseCancel(); });
    await waitFor(() => expect(startDownload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(q!.items[0].status).toBe('downloading'));
  });
});
