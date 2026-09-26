// Run async work at most `n` at a time. Used where Prism could start many
// yt-dlp lookups at once (a pasted batch): the backend caps concurrent
// lookups at six, and one at a time left a 100-link batch taking many
// minutes (REVIEW 2026-09-26).

export function createLimiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  const next = () => {
    active--;
    waiting.shift()?.();
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        task().then(resolve, reject).finally(next);
      };
      if (active < n) run();
      else waiting.push(run);
    });
}
