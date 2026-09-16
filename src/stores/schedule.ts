import type { AppPreferences, DownloadItem } from '@/types/models';

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

/** Day names by index, 0 = Sunday, matching `Date.getDay()`. Here with the day
 * logic so that ordering is written down once rather than in each page that
 * shows a weekday. */
export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** Which day a quiet-hours window counts as, for weekday selection.
 *
 * An overnight window belongs to the day it *began* on: with 22:00 → 06:00 and
 * Monday chosen, the small hours of Tuesday morning are still Monday's window.
 * Reading the calendar day instead would end the window at midnight, which is
 * not what "quiet hours on Monday night" means to anyone. */
export function windowStartDay(now: Date, startHour: number, endHour: number): number {
  const wrapsMidnight = startHour > endHour;
  if (wrapsMidnight && now.getHours() < startHour) {
    return (now.getDay() + 6) % 7; // the previous day
  }
  return now.getDay();
}

/** Whether the schedule applies today. No days chosen means every day, so a
 * schedule set before 2.0 keeps working untouched. */
function dayApplies(prefs: AppPreferences, now: Date): boolean {
  const days = prefs.scheduleDays;
  if (!days || days.length === 0) return true;
  return days.includes(windowStartDay(now, prefs.scheduleStartHour, prefs.scheduleEndHour));
}

/** Whether an item is waiting for its own start time.
 *
 * A stamp that won't parse lets the item start rather than stranding it: an
 * unreadable date should cost someone a scheduling preference, not a
 * download that never runs and never says why. */
export function itemStartBlocked(item: DownloadItem, now: Date): boolean {
  const startAt = item.settings.startAt;
  if (!startAt) return false;
  const at = Date.parse(startAt);
  if (Number.isNaN(at)) return false;
  return at > now.getTime();
}

export interface ScheduleGate {
  /** Hold queued items instead of starting them. */
  blockStarts: boolean;
  /** Override the item's speed limit at start, in bytes/sec. */
  speedLimitOverrideBytes: number | null;
}

const OPEN: ScheduleGate = { blockStarts: false, speedLimitOverrideBytes: null };

export interface QuietHoursStatus {
  mode: 'pause' | 'limit';
  /** "07:00" — when the window ends, for the banner. */
  until: string;
  /** Throttle mode only: the cap in MB/s. */
  limitMBps: number;
}

/** What the UI tells the user while quiet hours are in force, or null when
 * they aren't — so a held queue never looks like it's just waiting for a slot. */
export function quietHoursStatus(prefs: AppPreferences, now: Date): QuietHoursStatus | null {
  if (!prefs.scheduleEnabled) return null;
  if (!isInQuietHours(now.getHours(), prefs.scheduleStartHour, prefs.scheduleEndHour)) return null;
  if (!dayApplies(prefs, now)) return null;
  return {
    mode: prefs.scheduleMode,
    until: `${String(prefs.scheduleEndHour).padStart(2, '0')}:00`,
    limitMBps: Math.max(1, prefs.scheduleLimitMBps),
  };
}

export function scheduleGate(prefs: AppPreferences, now: Date): ScheduleGate {
  if (!prefs.scheduleEnabled) return OPEN;
  if (!isInQuietHours(now.getHours(), prefs.scheduleStartHour, prefs.scheduleEndHour)) return OPEN;
  if (!dayApplies(prefs, now)) return OPEN;
  if (prefs.scheduleMode === 'pause') {
    return { blockStarts: true, speedLimitOverrideBytes: null };
  }
  return { blockStarts: false, speedLimitOverrideBytes: Math.max(1, prefs.scheduleLimitMBps) * 1024 * 1024 };
}
