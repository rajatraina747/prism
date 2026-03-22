import { describe, it, expect, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { AppProvider, useQueue, useHistory, useSettings } from '../AppProvider';
import { ServiceProvider } from '@/services/ServiceProvider';
import type { DownloadItem } from '@/types/models';

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
    settings: {
      format: null,
      destination: '/downloads',
      filename: 'test',
      priority: 'normal',
      retryCount: 3,
      startImmediately: false,
    },
    status,
    progress: 0,
    speed: 0,
    eta: 0,
    downloadedBytes: 0,
    totalBytes: 100_000,
    retryAttempt: 0,
  };
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ServiceProvider>
      <AppProvider>{children}</AppProvider>
    </ServiceProvider>
  );
}

function QueueHelper({ onReady }: { onReady: (a: ReturnType<typeof useQueue>) => void }) {
  const actions = useQueue();
  onReady(actions);
  return <div data-testid="q">{actions.items.length}</div>;
}

function SettingsHelper({ onReady }: { onReady: (a: ReturnType<typeof useSettings>) => void }) {
  const actions = useSettings();
  onReady(actions);
  return <div data-testid="s">{actions.preferences.theme}</div>;
}

function HistoryHelper({ onReady }: { onReady: (a: ReturnType<typeof useHistory>) => void }) {
  const actions = useHistory();
  onReady(actions);
  return <div data-testid="h">{actions.items.length}</div>;
}

beforeEach(() => {
  localStorage.clear();
});

async function renderAndWait(ui: React.ReactElement) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(ui);
  });
  return result!;
}

describe('AppProvider - Queue', () => {
  it('starts with an empty queue', async () => {
    let q: ReturnType<typeof useQueue> | null = null;
    await renderAndWait(<Wrapper><QueueHelper onReady={a => { q = a; }} /></Wrapper>);
    await waitFor(() => expect(q).not.toBeNull());
    expect(q!.items).toHaveLength(0);
  });

  it('adds an item to the queue', async () => {
    let q: ReturnType<typeof useQueue> | null = null;
    await renderAndWait(<Wrapper><QueueHelper onReady={a => { q = a; }} /></Wrapper>);
    await waitFor(() => expect(q).not.toBeNull());

    act(() => { q!.addToQueue(makeItem('test-1')); });
    expect(q!.items).toHaveLength(1);
    expect(q!.items[0].id).toBe('test-1');
  });

  it('removes an item from the queue', async () => {
    let q: ReturnType<typeof useQueue> | null = null;
    await renderAndWait(<Wrapper><QueueHelper onReady={a => { q = a; }} /></Wrapper>);
    await waitFor(() => expect(q).not.toBeNull());

    act(() => { q!.addToQueue(makeItem('a')); q!.addToQueue(makeItem('b')); });
    act(() => { q!.removeFromQueue('a'); });
    expect(q!.items).toHaveLength(1);
    expect(q!.items[0].id).toBe('b');
  });

  it('pauses a download', async () => {
    let q: ReturnType<typeof useQueue> | null = null;
    await renderAndWait(<Wrapper><QueueHelper onReady={a => { q = a; }} /></Wrapper>);
    await waitFor(() => expect(q).not.toBeNull());

    act(() => { q!.addToQueue(makeItem('x', 'downloading')); });
    act(() => { q!.pauseDownload('x'); });
    expect(q!.items[0].status).toBe('paused');
    expect(q!.items[0].speed).toBe(0);
  });

  it('resumes a paused download (auto-starts)', async () => {
    let q: ReturnType<typeof useQueue> | null = null;
    await renderAndWait(<Wrapper><QueueHelper onReady={a => { q = a; }} /></Wrapper>);
    await waitFor(() => expect(q).not.toBeNull());

    act(() => { q!.addToQueue(makeItem('x', 'paused')); });
    act(() => { q!.resumeDownload('x'); });
    // The auto-start effect transitions queued → downloading immediately
    expect(['queued', 'downloading']).toContain(q!.items[0].status);
  });

  it('cancels a download', async () => {
    let q: ReturnType<typeof useQueue> | null = null;
    await renderAndWait(<Wrapper><QueueHelper onReady={a => { q = a; }} /></Wrapper>);
    await waitFor(() => expect(q).not.toBeNull());

    act(() => { q!.addToQueue(makeItem('x', 'downloading')); });
    act(() => { q!.cancelDownload('x'); });
    expect(q!.items[0].status).toBe('canceled');
  });

  it('retries a failed download (auto-starts)', async () => {
    let q: ReturnType<typeof useQueue> | null = null;
    await renderAndWait(<Wrapper><QueueHelper onReady={a => { q = a; }} /></Wrapper>);
    await waitFor(() => expect(q).not.toBeNull());

    act(() => { q!.addToQueue(makeItem('x', 'failed')); });
    act(() => { q!.retryDownload('x'); });
    // Auto-start may have already transitioned to downloading
    expect(['queued', 'downloading']).toContain(q!.items[0].status);
    expect(q!.items[0].retryAttempt).toBe(1);
  });

  it('reorders items', async () => {
    let q: ReturnType<typeof useQueue> | null = null;
    await renderAndWait(<Wrapper><QueueHelper onReady={a => { q = a; }} /></Wrapper>);
    await waitFor(() => expect(q).not.toBeNull());

    act(() => {
      q!.addToQueue(makeItem('a', 'paused'));
      q!.addToQueue(makeItem('b', 'paused'));
      q!.addToQueue(makeItem('c', 'paused'));
    });
    act(() => { q!.reorderQueue(2, 0); });
    expect(q!.items.map(i => i.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('AppProvider - Settings', () => {
  it('starts with default preferences', async () => {
    let s: ReturnType<typeof useSettings> | null = null;
    await renderAndWait(<Wrapper><SettingsHelper onReady={a => { s = a; }} /></Wrapper>);
    await waitFor(() => expect(s).not.toBeNull());
    expect(s!.preferences.theme).toBe('dark');
    expect(s!.preferences.maxConcurrentDownloads).toBe(3);
  });

  it('updates a preference', async () => {
    let s: ReturnType<typeof useSettings> | null = null;
    await renderAndWait(<Wrapper><SettingsHelper onReady={a => { s = a; }} /></Wrapper>);
    await waitFor(() => expect(s).not.toBeNull());

    act(() => { s!.updatePreference('theme', 'light'); });
    expect(s!.preferences.theme).toBe('light');
  });

  it('resets to defaults', async () => {
    let s: ReturnType<typeof useSettings> | null = null;
    await renderAndWait(<Wrapper><SettingsHelper onReady={a => { s = a; }} /></Wrapper>);
    await waitFor(() => expect(s).not.toBeNull());

    act(() => { s!.updatePreference('theme', 'light'); s!.updatePreference('maxConcurrentDownloads', 10); });
    act(() => { s!.resetToDefaults(); });
    expect(s!.preferences.theme).toBe('dark');
    expect(s!.preferences.maxConcurrentDownloads).toBe(3);
  });
});

describe('AppProvider - History', () => {
  it('starts empty', async () => {
    let h: ReturnType<typeof useHistory> | null = null;
    await renderAndWait(<Wrapper><HistoryHelper onReady={a => { h = a; }} /></Wrapper>);
    await waitFor(() => expect(h).not.toBeNull());
    expect(h!.items).toHaveLength(0);
  });

  it('clears history', async () => {
    let h: ReturnType<typeof useHistory> | null = null;
    await renderAndWait(<Wrapper><HistoryHelper onReady={a => { h = a; }} /></Wrapper>);
    await waitFor(() => expect(h).not.toBeNull());
    act(() => { h!.clearHistory(); });
    expect(h!.items).toHaveLength(0);
  });
});
