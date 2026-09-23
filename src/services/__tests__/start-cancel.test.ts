import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn(async (..._args: unknown[]) => undefined);
type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler>();
const unlistens: ReturnType<typeof vi.fn>[] = [];
let releaseListen: (() => void) | null = null;
// Each listen() resolves only when the test says so, so a cancel can land
// while startDownload is still setting up.
const listen = vi.fn((name: string, handler: Handler) => {
  listeners.set(name, handler);
  const unlisten = vi.fn();
  unlistens.push(unlisten);
  return new Promise<() => void>(resolve => {
    const previous = releaseListen;
    releaseListen = () => { previous?.(); resolve(unlisten); };
  });
});

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('@tauri-apps/plugin-deep-link', () => ({ getCurrent: vi.fn(async () => []), onOpenUrl: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(), readTextFile: vi.fn(), mkdir: vi.fn(),
  exists: vi.fn(async () => true), rename: vi.fn(), BaseDirectory: { AppData: 1 },
}));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(async () => true), requestPermission: vi.fn(), sendNotification: vi.fn(),
}));

async function freshService() {
  vi.resetModules();
  const { TauriPrismService } = await import('../tauri');
  return new TauriPrismService();
}

const torrentItem = {
  id: 't1',
  kind: 'torrent',
  metadata: { title: 'x', duration: 0, thumbnail: '', formats: [], source: { url: 'magnet:?xt=urn:btih:abc', domain: '', addedAt: '' } },
  settings: { format: null, destination: '/dl', filename: 'x', retryCount: 0, startImmediately: true },
  status: 'queued', progress: 0, speed: 0, eta: 0, downloadedBytes: 0, totalBytes: 0, retryAttempt: 0,
} as never;

beforeEach(() => {
  invoke.mockClear();
  listen.mockClear();
  listeners.clear();
  unlistens.length = 0;
  releaseListen = null;
});

// Regression (REVIEW 2026-09-23 B-5): a stop during setup was followed by
// the start anyway, with nothing left listening for it.
describe('startDownload stopped while setting up', () => {
  it('never starts the engine and drops its listeners', async () => {
    const service = await freshService();
    const cancel = service.startDownload(torrentItem, vi.fn(), vi.fn());
    cancel();
    // Let both listen() calls resolve, one after the other.
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(releaseListen).not.toBeNull());
      const release = releaseListen!;
      releaseListen = null;
      release();
      await new Promise(r => setTimeout(r, 0));
    }
    await new Promise(r => setTimeout(r, 10));
    expect(invoke).not.toHaveBeenCalledWith('start_torrent', expect.anything());
    expect(unlistens).toHaveLength(2);
    for (const unlisten of unlistens) expect(unlisten).toHaveBeenCalled();
  });

  it('starts normally when nothing stopped it', async () => {
    const service = await freshService();
    service.startDownload(torrentItem, vi.fn(), vi.fn());
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(releaseListen).not.toBeNull());
      const release = releaseListen!;
      releaseListen = null;
      release();
      await new Promise(r => setTimeout(r, 0));
    }
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('start_torrent', expect.objectContaining({ id: 't1' })));
  });
});

// Regression (REVIEW 2026-09-23 S-1): links read from a watch folder's text
// file need the confirmation card; a .torrent dropped there does not.
describe('watch-folder links', () => {
  it('asks before adding links from a text file', async () => {
    const service = await freshService();
    const handler = vi.fn();
    service.onDeepLink(handler);
    await vi.waitFor(() => expect(listeners.has('watch-folder-links')).toBe(true));
    listeners.get('watch-folder-links')!({
      payload: [
        { url: 'https://example.com/v', confirm: true },
        { url: 'magnet:?xt=urn:btih:abc', confirm: false },
        { url: 'https://example.com/w' },
      ],
    });
    expect(handler).toHaveBeenCalledWith('https://example.com/v', 'external');
    expect(handler).toHaveBeenCalledWith('magnet:?xt=urn:btih:abc', 'app');
    expect(handler).toHaveBeenCalledWith('https://example.com/w', 'external');
  });
});
