import { useSyncExternalStore } from 'react';
import type { EngineInfo } from '@/services/types';

// What the engine check last found, shared by the sidebar nudge and
// Settings → Updates. AppShell runs the daily check; Settings refreshes it when
// opened and after an update.

let current: EngineInfo | null = null;
const listeners = new Set<() => void>();

export function publishEngineInfo(info: EngineInfo | null): void {
  current = info;
  listeners.forEach(notify => notify());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useEngineStatus(): EngineInfo | null {
  return useSyncExternalStore(subscribe, () => current, () => current);
}
