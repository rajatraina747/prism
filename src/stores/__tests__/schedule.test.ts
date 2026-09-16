import { describe, it, expect } from 'vitest';
import { isInQuietHours, scheduleGate, windowStartDay, itemStartBlocked } from '../schedule';
import { DEFAULT_PREFERENCES, type AppPreferences, type DownloadItem } from '@/types/models';

function prefs(overrides: Partial<AppPreferences> = {}): AppPreferences {
  return {
    ...DEFAULT_PREFERENCES,
    scheduleEnabled: true,
    scheduleStartHour: 8,
    scheduleEndHour: 23,
    scheduleMode: 'limit',
    scheduleLimitMBps: 5,
    ...overrides,
  };
}

function at(hour: number): Date {
  const d = new Date();
  d.setHours(hour, 30, 0, 0);
  return d;
}

describe('isInQuietHours', () => {
  it('handles a same-day window', () => {
    expect(isInQuietHours(8, 8, 23)).toBe(true);
    expect(isInQuietHours(22, 8, 23)).toBe(true);
    expect(isInQuietHours(23, 8, 23)).toBe(false); // end is exclusive
    expect(isInQuietHours(3, 8, 23)).toBe(false);
  });

  it('handles an overnight window', () => {
    expect(isInQuietHours(23, 22, 6)).toBe(true);
    expect(isInQuietHours(2, 22, 6)).toBe(true);
    expect(isInQuietHours(6, 22, 6)).toBe(false);
    expect(isInQuietHours(12, 22, 6)).toBe(false);
  });

  it('treats start === end as an empty window', () => {
    expect(isInQuietHours(10, 10, 10)).toBe(false);
    expect(isInQuietHours(0, 10, 10)).toBe(false);
  });
});

describe('scheduleGate', () => {
  it('is open when the schedule is disabled', () => {
    const gate = scheduleGate(prefs({ scheduleEnabled: false }), at(12));
    expect(gate).toEqual({ blockStarts: false, speedLimitOverrideBytes: null });
  });

  it('is open outside the window', () => {
    const gate = scheduleGate(prefs(), at(2));
    expect(gate).toEqual({ blockStarts: false, speedLimitOverrideBytes: null });
  });

  it('blocks starts in pause mode inside the window', () => {
    const gate = scheduleGate(prefs({ scheduleMode: 'pause' }), at(12));
    expect(gate.blockStarts).toBe(true);
    expect(gate.speedLimitOverrideBytes).toBeNull();
  });

  it('overrides the speed limit in limit mode inside the window', () => {
    const gate = scheduleGate(prefs({ scheduleLimitMBps: 3 }), at(12));
    expect(gate.blockStarts).toBe(false);
    expect(gate.speedLimitOverrideBytes).toBe(3 * 1024 * 1024);
  });

  it('clamps a zero limit up to 1 MB/s instead of unlimited', () => {
    // speedLimit 0 means "unlimited" downstream, which would invert the intent
    const gate = scheduleGate(prefs({ scheduleLimitMBps: 0 }), at(12));
    expect(gate.speedLimitOverrideBytes).toBe(1024 * 1024);
  });
});

// 01:30 on some day. The weekday is derived from the fixture rather than
// written down: hard-coding one would make these pass or fail depending on
// what day the suite happens to run.
const NIGHT = new Date(2026, 8, 15, 1, 30);
const NIGHT_OWNER = (NIGHT.getDay() + 6) % 7; // the evening it began on

describe('windowStartDay', () => {
  it('gives an overnight window to the day it started on', () => {
    // 22:00 → 06:00: the small hours belong to the previous evening, which is
    // what "quiet hours on a Monday night" means to a person.
    expect(windowStartDay(NIGHT, 22, 6)).toBe(NIGHT_OWNER);
  });

  it('gives a same-day window to the calendar day', () => {
    const noon = new Date(2026, 8, 15, 12, 0);
    expect(windowStartDay(noon, 8, 23)).toBe(noon.getDay());
  });

  it('keeps the evening half of an overnight window on its own day', () => {
    const evening = new Date(2026, 8, 15, 23, 0);
    expect(windowStartDay(evening, 22, 6)).toBe(evening.getDay());
  });
});

describe('scheduleGate with chosen days', () => {
  const overnight = { scheduleStartHour: 22, scheduleEndHour: 6, scheduleMode: 'pause' as const };

  it('applies on every day when no days are chosen', () => {
    // Back-compat: a schedule set before weekdays existed must not change.
    expect(scheduleGate(prefs(overnight), NIGHT).blockStarts).toBe(true);
    expect(scheduleGate(prefs({ ...overnight, scheduleDays: [] }), NIGHT).blockStarts).toBe(true);
  });

  it('applies when the evening it began on was chosen', () => {
    const gate = scheduleGate(prefs({ ...overnight, scheduleDays: [NIGHT_OWNER] }), NIGHT);
    expect(gate.blockStarts).toBe(true);
  });

  it('does not apply merely because the calendar day was chosen', () => {
    // The trap: 01:30 falls on the next calendar day, but that day was not the
    // one the window started on.
    const gate = scheduleGate(prefs({ ...overnight, scheduleDays: [NIGHT.getDay()] }), NIGHT);
    expect(gate.blockStarts).toBe(false);
  });

  it('leaves the gate open on a day that was not chosen', () => {
    const noon = new Date(2026, 8, 15, 12, 0);
    const otherDay = (noon.getDay() + 3) % 7;
    const gate = scheduleGate(prefs({ scheduleMode: 'pause', scheduleDays: [otherDay] }), noon);
    expect(gate.blockStarts).toBe(false);
  });
});

describe('itemStartBlocked', () => {
  const now = new Date(2026, 8, 15, 12, 0);
  const item = (startAt?: string): DownloadItem =>
    ({ settings: { startAt } } as unknown as DownloadItem);

  it('holds an item back until its time', () => {
    expect(itemStartBlocked(item(new Date(2026, 8, 15, 18, 0).toISOString()), now)).toBe(true);
  });

  it('lets an item start once its time has passed', () => {
    expect(itemStartBlocked(item(new Date(2026, 8, 15, 9, 0).toISOString()), now)).toBe(false);
  });

  it('leaves an item without a start time alone', () => {
    expect(itemStartBlocked(item(), now)).toBe(false);
  });

  it('lets an item start when its start time is unreadable', () => {
    // A stamp that won't parse should cost a scheduling preference, not strand
    // a download that never runs and never explains why.
    expect(itemStartBlocked(item('not a date'), now)).toBe(false);
  });
});
