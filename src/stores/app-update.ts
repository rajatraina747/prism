import { useSyncExternalStore } from 'react';
import { formatBytes } from '@/services/utils';

// The app update being installed, kept outside any page. It used to live in
// the Settings page's state: leaving the page and coming back showed "Install
// Update" again, and a second click started a second download of the whole
// app beside the first. The launch-time "Update available" toast installs
// through here too, so there is one download however it was asked for.

export interface UpdateInstall {
  installing: boolean;
  downloaded: number;
  /** Bytes in the update, when the server said. */
  total: number | null;
}

const IDLE: UpdateInstall = { installing: false, downloaded: 0, total: null };

let state: UpdateInstall = IDLE;
let running: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: UpdateInstall) {
  state = next;
  listeners.forEach(l => l());
}

export function getUpdateInstall(): UpdateInstall {
  return state;
}

export function subscribeUpdateInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUpdateInstall(): UpdateInstall {
  return useSyncExternalStore(subscribeUpdateInstall, getUpdateInstall, getUpdateInstall);
}

/** Install the pending update, or join the install already running. */
export function installAppUpdate(
  install: (onProgress: (downloaded: number, total: number | null) => void) => Promise<void>,
): Promise<void> {
  if (running) return running;
  set({ installing: true, downloaded: 0, total: null });
  running = install((downloaded, total) => set({ installing: true, downloaded, total }))
    .finally(() => {
      running = null;
      set(IDLE);
    });
  return running;
}

/** "45% · 60.2 MB of 134.4 MB", or just the bytes when the size is unknown. */
export function formatUpdateProgress({ downloaded, total }: UpdateInstall): string {
  if (total && total > 0) {
    const pct = Math.min(100, Math.floor((downloaded / total) * 100));
    return `${pct}% · ${formatBytes(downloaded)} of ${formatBytes(total)}`;
  }
  return downloaded > 0 ? `${formatBytes(downloaded)} downloaded` : 'Starting download…';
}
