import { describe, it, expect } from 'vitest';
import { isInQuietHours, scheduleGate } from '../schedule';
import { DEFAULT_PREFERENCES, type AppPreferences } from '@/types/models';

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
