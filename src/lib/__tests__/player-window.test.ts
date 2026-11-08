import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
const emitTo = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: {
    getByLabel: async () => ({ unminimize: async () => {}, setFocus: async () => {} }),
  },
}));

import { playOpenedMedia } from '../player-window';

function respond(opened: unknown, available: boolean) {
  invoke.mockImplementation(async (cmd: string) => (cmd === 'take_opened_media' ? opened : available));
}

describe('playOpenedMedia', () => {
  beforeEach(() => {
    invoke.mockReset();
    emitTo.mockReset();
  });

  it('does nothing when no file is waiting', async () => {
    respond(null, false);
    await expect(playOpenedMedia()).resolves.toBeUndefined();
    expect(emitTo).not.toHaveBeenCalled();
  });

  it('refuses without a player instead of opening a window that fails', async () => {
    respond({ path: '/a/b.mp4', title: 'b.mp4' }, false);
    await expect(playOpenedMedia()).rejects.toThrow(/isn't available/);
    expect(emitTo).not.toHaveBeenCalled();
  });

  it('plays the file Rust handed over', async () => {
    respond({ path: '/a/b.mp4', title: 'b.mp4' }, true);
    await playOpenedMedia();
    expect(emitTo).toHaveBeenCalledWith('player', 'player-load', { path: '/a/b.mp4', title: 'b.mp4' });
  });
});
