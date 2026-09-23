import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { AppProvider, useQueue, useHistory, useSettings } from '../AppProvider';
import { ServiceProvider } from '@/services/ServiceProvider';
import type { DownloadItem } from '@/types/models';
import { MockPrismService } from '@/services/mock';
import { toast } from 'sonner';

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

  // Regression (v1.8.0): the archive timer re-armed on every queue change, so
  // while any transfer was emitting progress a completed item never moved to
  // the Library — and the Transfers page hides completed rows, so it vanished.
  it('archives a completed item even while the queue keeps changing', async () => {
    let q: ReturnType<typeof useQueue> | null = null;
    let h: ReturnType<typeof useHistory> | null = null;
    await renderAndWait(
      <Wrapper>
        <QueueHelper onReady={a => { q = a; }} />
        <HistoryHelper onReady={a => { h = a; }} />
      </Wrapper>,
    );
    await waitFor(() => expect(q).not.toBeNull());

    vi.useFakeTimers();
    try {
      act(() => { q!.addToQueue(makeItem('done', 'completed')); });
      // Mutate the queue every 100 ms for a second — the cadence of a torrent's
      // progress events. Paused items are inert (never auto-started).
      for (let i = 0; i < 10; i++) {
        act(() => { vi.advanceTimersByTime(100); });
        act(() => { q!.addToQueue(makeItem(`busy-${i}`, 'paused')); });
      }
      expect(h!.items.map(i => i.id)).toContain('done');
      expect(q!.items.find(i => i.id === 'done')).toBeUndefined();
      expect(q!.items).toHaveLength(10);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Regression (REVIEW 2026-09-23 P-1): callbacks that closed over the queue
// changed identity on every progress tick, breaking QueueRow's memo.
describe('AppProvider - stable callbacks', () => {
  it('keeps queue actions and settings the same across queue changes', async () => {
    let q: ReturnType<typeof useQueue> | null = null;
    let s: ReturnType<typeof useSettings> | null = null;
    await renderAndWait(
      <Wrapper>
        <QueueHelper onReady={a => { q = a; }} />
        <SettingsHelper onReady={a => { s = a; }} />
      </Wrapper>,
    );
    await waitFor(() => expect(q).not.toBeNull());
    const before = q!;
    const settingsBefore = s!;
    act(() => { q!.addToQueue(makeItem('p1', 'paused')); });
    expect(q!.items).toHaveLength(1);
    for (const name of ['pauseDownload', 'resumeDownload', 'cancelDownload', 'startAll', 'pauseAll', 'removeWithData', 'moveToTop', 'moveToBottom'] as const) {
      expect(q![name], name).toBe(before[name]);
    }
    expect(s, 'settings context untouched by a queue change').toBe(settingsBefore);
  });
});

// Regression (REVIEW 2026-09-23): completion read the settings captured when
// the download started, so turning notifications off mid-download did nothing.
describe('AppProvider - completion reads current settings', () => {
  it('honours notifications turned off while the download ran', async () => {
    type Complete = Parameters<MockPrismService['startDownload']>[2];
    let complete: Complete | null = null;
    const start = vi.spyOn(MockPrismService.prototype, 'startDownload').mockImplementation((_item, _progress, done) => {
      complete = done;
      return () => {};
    });
    const success = vi.spyOn(toast, 'success');
    try {
      let q: ReturnType<typeof useQueue> | null = null;
      let s: ReturnType<typeof useSettings> | null = null;
      await renderAndWait(
        <Wrapper>
          <QueueHelper onReady={a => { q = a; }} />
          <SettingsHelper onReady={a => { s = a; }} />
        </Wrapper>,
      );
      await waitFor(() => expect(q).not.toBeNull());
      act(() => { s!.updatePreference('notificationsEnabled', true); });
      const item = { ...makeItem('n1'), settings: { ...makeItem('n1').settings, startImmediately: true } };
      act(() => { q!.addToQueue(item); });
      await waitFor(() => expect(complete).not.toBeNull());
      act(() => { s!.updatePreference('notificationsEnabled', false); });
      success.mockClear();
      act(() => { complete!(true, undefined, '/downloads/n1.mp4', 10); });
      expect(success).not.toHaveBeenCalledWith(expect.stringContaining('Downloaded:'));
    } finally {
      start.mockRestore();
      success.mockRestore();
    }
  });
});

