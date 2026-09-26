import { describe, it, expect } from 'vitest';
import { createLatestWriter, createHistoryWriter, historyChange } from '../db-writers';

describe('createLatestWriter', () => {
  it('writes one at a time and ends on the newest value', async () => {
    const written: number[] = [];
    let release!: () => void;
    const write = createLatestWriter<number>(async v => {
      written.push(v);
      if (v === 1) await new Promise<void>(r => { release = r; });
    }, () => {});
    write(1); write(2); write(3);
    release();
    await new Promise(r => setTimeout(r, 0));
    expect(written).toEqual([1, 3]);
  });
});

describe('history changes', () => {
  const a = { id: 'a', v: 1 }, b = { id: 'b', v: 1 }, c = { id: 'c', v: 1 };

  it('sends only new or changed rows and the removed ids', () => {
    const saved = new Map([['a', a], ['b', b]]);
    const b2 = { ...b, v: 2 };
    expect(historyChange(saved, [c, a, b2])).toEqual({ put: [c, b2], remove: [], clear: false });
    expect(historyChange(saved, [a])).toEqual({ put: [], remove: ['b'], clear: false });
    expect(historyChange(saved, [])).toEqual({ put: [], remove: [], clear: true });
  });

  it('a loaded Library is not written back, and each change goes once', async () => {
    const sent: unknown[] = [];
    const writer = createHistoryWriter<{ id: string; v: number }>(async ch => { sent.push(ch); }, () => {});
    writer.seed([a, b]);
    writer.save([a, b]);
    await new Promise(r => setTimeout(r, 0));
    expect(sent).toEqual([]);
    writer.save([c, a, b]);
    await new Promise(r => setTimeout(r, 0));
    expect(sent).toEqual([{ put: [c], remove: [], clear: false }]);
  });
});
