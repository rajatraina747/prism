import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emitTo } from '@tauri-apps/api/event';

// Opens (or reuses) the dedicated "player" window. The player is a separate
// transparent window because mpv embeds into a window's native view *beneath*
// the whole webview — doing that to the main window would force the entire UI
// to manage transparency. See src/pages/Player.tsx.

export interface PlayerSource {
  path: string;
  title?: string;
}

/** Event the player window listens on for follow-up "play this instead" loads. */
export const PLAYER_LOAD_EVENT = 'player-load';

/** mpv gets paths verbatim — it won't expand a shell-style `~`. */
async function expandTilde(p: string): Promise<string> {
  if (p !== '~' && !p.startsWith('~/')) return p;
  const { homeDir } = await import('@tauri-apps/api/path');
  const home = (await homeDir()).replace(/\/+$/, '');
  return p === '~' ? home : `${home}/${p.slice(2)}`;
}

export async function openInPlayer(raw: PlayerSource): Promise<void> {
  const src: PlayerSource = { ...raw, path: await expandTilde(raw.path) };
  const existing = await WebviewWindow.getByLabel('player');
  if (existing) {
    await emitTo('player', PLAYER_LOAD_EVENT, src);
    await existing.unminimize().catch(() => {});
    await existing.setFocus().catch(() => {});
    return;
  }

  const params = new URLSearchParams({ src: src.path });
  if (src.title) params.set('title', src.title);

  const win = new WebviewWindow('player', {
    url: `/player?${params.toString()}`,
    title: src.title ?? 'Prism Player',
    width: 1024,
    height: 640,
    minWidth: 480,
    minHeight: 320,
    // Transparent so mpv (rendering beneath the webview) shows through
    // everywhere the page doesn't paint.
    transparent: true,
    center: true,
  });
  await new Promise<void>((resolve, reject) => {
    void win.once('tauri://created', () => resolve());
    void win.once('tauri://error', (e) => reject(new Error(String(e.payload))));
  });
}
