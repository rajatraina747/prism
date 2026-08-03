import { describe, it, expect, vi, beforeEach } from 'vitest';

const getCurrent = vi.fn<() => Promise<string[] | null>>();
const onOpenUrl = vi.fn(async (_cb: (urls: string[]) => void) => () => {});

vi.mock('@tauri-apps/plugin-deep-link', () => ({ getCurrent, onOpenUrl }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
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

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef';

/** Fresh module per test — the launch link is one-shot per process. */
async function freshService() {
  vi.resetModules();
  const { TauriPrismService } = await import('../tauri');
  return new TauriPrismService();
}

describe('onDeepLink launch link', () => {
  beforeEach(() => {
    getCurrent.mockReset();
    getCurrent.mockResolvedValue([MAGNET]);
  });

  it('delivers the link the app was launched with', async () => {
    const service = await freshService();
    const handler = vi.fn();
    service.onDeepLink(handler);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(MAGNET));
  });

  it('does not replay it when the subscription is re-created', async () => {
    const service = await freshService();
    const first = vi.fn();
    const unsubscribe = service.onDeepLink(first);
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    unsubscribe();

    // Windows/Linux keep returning the launch link from getCurrent() forever —
    // re-subscribing must not re-submit the magnet the user already added.
    const second = vi.fn();
    service.onDeepLink(second);
    await new Promise(r => setTimeout(r, 20));
    expect(second).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('delivers to a later subscriber if the first was torn down before it resolved', async () => {
    const service = await freshService();
    const dropped = vi.fn();
    service.onDeepLink(dropped)(); // subscribe and immediately unsubscribe

    const next = vi.fn();
    service.onDeepLink(next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(MAGNET));
    expect(dropped).not.toHaveBeenCalled();
  });

  it('reads getCurrent only once per process', async () => {
    const service = await freshService();
    service.onDeepLink(vi.fn());
    await vi.waitFor(() => expect(getCurrent).toHaveBeenCalledTimes(1));
    service.onDeepLink(vi.fn());
    service.onDeepLink(vi.fn());
    await new Promise(r => setTimeout(r, 20));
    expect(getCurrent).toHaveBeenCalledTimes(1);
  });

  it('still delivers links that arrive while running', async () => {
    getCurrent.mockResolvedValue(null);
    const service = await freshService();
    const handler = vi.fn();
    service.onDeepLink(handler);

    await vi.waitFor(() => expect(onOpenUrl).toHaveBeenCalled());
    const emit = onOpenUrl.mock.calls.at(-1)![0];
    emit([MAGNET]);
    expect(handler).toHaveBeenCalledWith(MAGNET);
  });
});
