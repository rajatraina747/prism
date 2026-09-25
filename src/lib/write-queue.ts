// One write at a time per file, and only the newest content matters.
//
// Every save of a JSON file goes write-`.tmp`-then-rename, through one shared
// `<file>.tmp`. Two saves of the same file in flight at once (settings are
// saved on every change, without a debounce) could interleave: one rename
// moving the other's half-written temp file into place, which the next launch
// reads as corrupt and silently resets (REVIEW 2026-09-26 L2). So writes to a
// file run one after another; content that arrives while one is running
// waits, and anything superseded before its turn is skipped.

export type WriteFn = (file: string, text: string) => Promise<void>;

export function createWriteQueue(write: WriteFn): WriteFn {
  const running = new Map<string, Promise<void>>();
  const waiting = new Map<string, string>();

  const drain = async (file: string): Promise<void> => {
    let text = waiting.get(file);
    while (text !== undefined) {
      waiting.delete(file);
      try {
        await write(file, text);
      } catch {
        // A failed save is retried by the next one; the caller has moved on.
      }
      text = waiting.get(file);
    }
    running.delete(file);
  };

  return (file, text) => {
    waiting.set(file, text);
    let run = running.get(file);
    if (!run) {
      run = drain(file);
      running.set(file, run);
    }
    return run;
  };
}
