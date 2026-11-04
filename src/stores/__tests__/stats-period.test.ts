import { describe, expect, it } from 'vitest';
import { emptyStats, periodTotals, chartBuckets, resetStats, backfillFromHistory, type Stats } from '../stats';
import type { HistoryItem } from '@/types/models';

const now = new Date(2026, 10, 5, 12); // 5 Nov 2026, local
function withDays(days: Record<string, [number, number]>): Stats {
  const s = emptyStats(new Date(2026, 0, 10));
  for (const [k, [items, bytes]] of Object.entries(days)) {
    s.byDay[k] = { items, bytes };
    s.completed += items;
    s.bytes += bytes;
  }
  return s;
}

describe('activity periods', () => {
  const s = withDays({ '2026-11-05': [1, 100], '2026-11-01': [2, 200], '2026-10-01': [3, 300], '2026-02-01': [4, 400], unknown: [9, 900] });

  it('sums only the days inside the period, counting today', () => {
    expect(periodTotals(s, 7, now)).toEqual({ items: 3, bytes: 300 });
    expect(periodTotals(s, 90, now)).toEqual({ items: 6, bytes: 600 });
    expect(periodTotals(s, 365, now)).toEqual({ items: 10, bytes: 1000 });
  });

  it('all time is the lifetime counters, unknown days included', () => {
    expect(periodTotals(s, 'all', now)).toEqual({ items: 19, bytes: 1900 });
  });

  it('charts days up to 90, then months', () => {
    expect(chartBuckets(s, 30, now)).toHaveLength(30);
    const year = chartBuckets(s, 365, now);
    expect(year).toHaveLength(12);
    expect(year[year.length - 1]).toEqual({ label: '2026-11', items: 3, bytes: 300 });
    const all = chartBuckets(s, 'all', now);
    expect(all[0].label).toBe('2026-01');
    expect(all.find(b => b.label === '2026-02')?.bytes).toBe(400);
  });
});

describe('reset', () => {
  it('starts from zero and does not count the existing Library again', () => {
    const fresh = resetStats(now);
    expect(fresh.completed).toBe(0);
    expect(fresh.since).toBe(now.toISOString());
    const old: HistoryItem = {
      id: 'a', status: 'completed', completedAt: new Date(2026, 9, 1).toISOString(), fileSize: 5,
      metadata: { title: 't', duration: 0, thumbnail: '', source: { url: 'https://x.com/v', domain: 'x.com', addedAt: '' }, formats: [] },
      settings: { format: null, destination: '', filename: '', startImmediately: true },
    } as HistoryItem;
    expect(backfillFromHistory(fresh, [old]).completed).toBe(0);
    const later = { ...old, id: 'b', completedAt: new Date(2026, 10, 6).toISOString() };
    expect(backfillFromHistory(fresh, [old, later]).completed).toBe(1);
  });
});
