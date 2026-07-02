import type { AppPreferences } from '@/types/models';

// Quiet-hours schedule: between start and end hour, new downloads are either
// held (mode 'pause') or started with a throttled speed limit (mode 'limit').
// Applied when a download *starts* — yt-dlp takes its rate limit at spawn, so
// already-running downloads keep the limit they started with.

/** True when `hour` falls inside [start, end), handling overnight wrap
 * (e.g. 22 → 6). start === end means an empty window (never active). */
export function isInQuietHours(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

export interface ScheduleGate {
  /** Hold queued items instead of starting them. */
  blockStarts: boolean;
  /** Override the item's speed limit at start, in bytes/sec. */
  speedLimitOverrideBytes: number | null;
}

const OPEN: ScheduleGate = { blockStarts: false, speedLimitOverrideBytes: null };

export function scheduleGate(prefs: AppPreferences, now: Date): ScheduleGate {
  if (!prefs.scheduleEnabled) return OPEN;
  if (!isInQuietHours(now.getHours(), prefs.scheduleStartHour, prefs.scheduleEndHour)) return OPEN;
  if (prefs.scheduleMode === 'pause') {
    return { blockStarts: true, speedLimitOverrideBytes: null };
  }
  return { blockStarts: false, speedLimitOverrideBytes: Math.max(1, prefs.scheduleLimitMBps) * 1024 * 1024 };
}
