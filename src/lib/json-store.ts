// Reading and writing Prism's JSON files without ever losing one quietly.
//
// A file that didn't parse used to load as its fallback (an empty Library, a
// default settings object), and the next save wrote that over the damaged
// file: one bad write, or a disk hiccup, and everything in it was gone with
// no word to anyone (REVIEW 2026-09-26). Now:
//
// - every save first moves the previous good copy to `<name>.bak.json`;
// - a file that won't parse is renamed to `<name>.corrupt-<time>.json` (never
//   overwritten, never deleted) and the backup is loaded in its place;
// - either way the problem is reported, so the user hears about it.
//
// Names stay `*.json` / `*.json.tmp`, the only names the page's file access
// covers (src-tauri/capabilities/default.json).

export interface JsonFs {
  read(file: string): Promise<string>;
  write(file: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export type StoreProblem =
  /** Damaged, and the backup loaded in its place. */
  | { kind: 'recovered'; file: string; keptAs: string | null }
  /** Damaged, and no usable backup: started from the fallback. */
  | { kind: 'reset'; file: string; keptAs: string | null }
  /** A save didn't reach the disk. */
  | { kind: 'save-failed'; file: string };

export function backupName(file: string): string {
  return file.replace(/\.json$/, '.bak.json');
}

export function corruptName(file: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return file.replace(/\.json$/, `.corrupt-${stamp}.json`);
}

async function readParsed<T>(fs: JsonFs, file: string): Promise<{ ok: true; value: T } | { ok: false; unreadable: boolean }> {
  let text: string;
  try {
    text = await fs.read(file);
  } catch {
    // Missing (first launch, or a crash between the two renames of a save).
    return { ok: false, unreadable: true };
  }
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, unreadable: false };
  }
}

/** Load `file`, falling back to its backup, then to `fallback`. */
export async function loadJson<T>(
  fs: JsonFs,
  file: string,
  fallback: T,
  report: (problem: StoreProblem) => void,
  now: () => Date = () => new Date(),
): Promise<T> {
  const main = await readParsed<T>(fs, file);
  if (main.ok) return main.value;

  let keptAs: string | null = null;
  if (!main.unreadable) {
    // Read but not JSON: keep it aside rather than let a save replace it.
    const target = corruptName(file, now());
    try {
      await fs.rename(file, target);
      keptAs = target;
    } catch {
      keptAs = null;
    }
  }

  const backup = await readParsed<T>(fs, backupName(file));
  if (backup.ok) {
    // A missing file with a good backup is the gap between a save's two
    // renames; nothing was lost, so there is nothing to report.
    if (!main.unreadable) report({ kind: 'recovered', file, keptAs });
    return backup.value;
  }
  if (!main.unreadable) report({ kind: 'reset', file, keptAs });
  return fallback;
}

/** Save `text` as `file`: write `<file>.tmp`, move the current file to the
 * backup, move the temp file into place. Throws if the new content didn't
 * land. */
export async function saveJson(fs: JsonFs, file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.write(tmp, text);
  try {
    await fs.rename(file, backupName(file));
  } catch {
    // No current file yet (first save, or it was set aside as corrupt).
  }
  await fs.rename(tmp, file);
}
