import { describe, it, expect } from 'vitest';
import { quietHoursStatus } from '../schedule';
import { DEFAULT_PREFERENCES } from '@/types/models';

const at = (hour: number) => new Date(2026, 8, 15, hour, 30);

describe('quietHoursStatus', () => {
  const prefs = { ...DEFAULT_PREFERENCES, scheduleEnabled: true, scheduleStartHour: 22, scheduleEndHour: 7 };

  it('is null when disabled or outside the window', () => {
    expect(quietHoursStatus({ ...prefs, scheduleEnabled: false }, at(23))).toBeNull();
    expect(quietHoursStatus(prefs, at(12))).toBeNull();
  });

  it('reports mode and a zero-padded end time across midnight', () => {
    expect(quietHoursStatus({ ...prefs, scheduleMode: 'pause' }, at(2))).toEqual({ mode: 'pause', until: '07:00', limitMBps: 5 });
    expect(quietHoursStatus({ ...prefs, scheduleMode: 'limit', scheduleLimitMBps: 0 }, at(23))).toMatchObject({ mode: 'limit', limitMBps: 1 });
  });
});
