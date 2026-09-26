// Saving to the database (src-tauri/src/store.rs) from the page.
//
// Two shapes. The queue and small documents are replaced whole, and only the
// newest value matters: one write at a time, anything superseded while one
// runs is skipped. The Library is thousands of rows, so it is saved as a
// change — the rows added or replaced, and the ones removed — worked out
// against what was last saved, by object identity (state updates make new
// objects for changed rows and keep the rest).

export function createLatestWriter<T>(
  write: (value: T) => Promise<void>,
  onError: (error: unknown) => void,
): (value: T) => void {
  let running = false;
  let waiting: { value: T } | null = null;
  const drain = async () => {
    running = true;
    while (waiting) {
      const { value } = waiting;
      waiting = null;
      try {
        await write(value);
      } catch (e) {
        onError(e);
      }
    }
    running = false;
  };
  return (value: T) => {
    waiting = { value };
    if (!running) void drain();
  };
}

interface Row { id: string }

export interface HistoryChange<T> {
  put: T[];
  remove: string[];
  clear: boolean;
}

/** The change from `saved` to `next`. */
export function historyChange<T extends Row>(saved: Map<string, T>, next: T[]): HistoryChange<T> {
  if (next.length === 0 && saved.size > 0) return { put: [], remove: [], clear: true };
  const ids = new Set<string>();
  const put: T[] = [];
  for (const row of next) {
    ids.add(row.id);
    if (saved.get(row.id) !== row) put.push(row);
  }
  const remove = [...saved.keys()].filter(id => !ids.has(id));
  return { put, remove, clear: false };
}

export function createHistoryWriter<T extends Row>(
  send: (change: HistoryChange<T>) => Promise<void>,
  onError: (error: unknown) => void,
) {
  let saved = new Map<string, T>();
  const write = createLatestWriter<T[]>(async next => {
    const change = historyChange(saved, next);
    if (!change.clear && change.put.length === 0 && change.remove.length === 0) return;
    await send(change);
    saved = new Map(next.map(row => [row.id, row]));
  }, onError);
  return {
    /** What was loaded: already saved, so not sent back. */
    seed(rows: T[]) {
      saved = new Map(rows.map(row => [row.id, row]));
    },
    save: write,
  };
}
