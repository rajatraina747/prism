import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emitTo } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

// Opens (or reuses) the dedicated "player" window. The player is a separate
// transparent window because mpv embeds into a window's native view *beneath*
// the whole webview — doing that to the main window would force the entire UI
// to manage transparency. See src/pages/Player.tsx.

/** A file of a torrent that is still downloading, served over loopback by
 * src-tauri/src/stream_server.rs rather than opened from disk. */
export interface PlayerStream {
  torrentId: string;
  fileIdx: number;
}

export interface PlayerSource {
  /** A file on disk. Absent when playing a `stream`. */
  path?: string;
  /** A torrent file to stream while it downloads. Takes precedence over `path`. */
  stream?: PlayerStream;
  /** "Open file…": Rust shows the picker and loads whatever is chosen. */
  pick?: true;
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
  const src: PlayerSource = raw.path ? { ...raw, path: await expandTilde(raw.path) } : raw;
  const existing = await WebviewWindow.getByLabel('player');
  if (existing) {
    await emitTo('player', PLAYER_LOAD_EVENT, src);
    await existing.unminimize().catch(() => {});
    await existing.setFocus().catch(() => {});
    return;
  }

  const params = new URLSearchParams();
  if (src.stream) {
    params.set('torrentId', src.stream.torrentId);
    params.set('fileIdx', String(src.stream.fileIdx));
  } else if (src.path) {
    params.set('src', src.path);
  }
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
    // Files dropped on the player reach Rust as a native event
    // (player::on_player_drop), which validates them and loads the first.
    dragDropEnabled: true,
  });
  await new Promise<void>((resolve, reject) => {
    void win.once('tauri://created', () => resolve());
    void win.once('tauri://error', (e) => reject(new Error(String(e.payload))));
  });
}

/** "Play a File…" (⌘O, Library): Rust shows the picker and remembers the
 * choice, so the player accepts it from any folder or drive. Resolves to
 * false when the user cancels. */
export async function pickAndPlay(): Promise<boolean> {
  // ⌘O works on every page, but not every build has libmpv (Linux, some dev
  // builds): say so rather than opening a player window that can't start.
  if (!(await invoke<boolean>('player_available'))) {
    throw new Error("the built-in player isn't available in this build");
  }
  const picked = await invoke<{ path: string; title: string } | null>('pick_media_file');
  if (!picked) return false;
  await openInPlayer({ path: picked.path, title: picked.title });
  return true;
}
