import type { AppPreferences, HistoryItem, Subscription } from '@/types/models';
import { migrateSettings } from '@/stores/settings-migrations';

// Settings, Library and subscriptions in one file (`prism-export-v1`), to move
// Prism to another Mac or keep a copy. Pure, so what goes in and what comes
// back is tested without a file dialog.
//
// Deliberately left out:
// - The folders Prism may write to outside Home and Downloads. Rust keeps
//   those, and only a folder the user picks in a dialog on *this* machine
//   becomes one. A file must never be able to grant itself write access.
// - This machine's own folders (download, move-completed, watch folders):
//   paths from another Mac rarely exist here, and a watch folder that
//   suddenly points somewhere else would add whatever it finds there.
// - Statistics: lifetime counters, which a merge would count twice.
// - The queue: its items are tied to this machine's partial files.

export const BACKUP_FORMAT = 'prism-export';
export const BACKUP_VERSION = 1;
const HISTORY_CAP = 2000;

/** Settings that name folders on this machine; import keeps the current ones. */
const LOCAL_FOLDER_SETTINGS = ['defaultSaveFolder', 'moveCompletedTo', 'watchFolders'] as const;

export interface PrismBackup {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  appVersion: string;
  settings: Partial<AppPreferences>;
  history: HistoryItem[];
  subscriptions: Subscription[];
}

export function buildBackup(input: {
  settings: AppPreferences;
  history: HistoryItem[];
  subscriptions: Subscription[];
  appVersion: string;
  now?: Date;
}): PrismBackup {
  const settings: Partial<AppPreferences> = { ...input.settings };
  for (const key of LOCAL_FOLDER_SETTINGS) delete settings[key];
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: (input.now ?? new Date()).toISOString(),
    appVersion: input.appVersion,
    settings,
    history: input.history,
    subscriptions: input.subscriptions,
  };
}

export type ParsedBackup = { ok: true; backup: PrismBackup } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Read a backup file, refusing anything that isn't one Prism can use. */
export function parseBackup(text: string): ParsedBackup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't a Prism backup (it isn't valid JSON)." };
  }
  if (!isObject(raw) || raw.format !== BACKUP_FORMAT) {
    return { ok: false, error: "That file isn't a Prism backup." };
  }
  if (typeof raw.version !== 'number' || raw.version > BACKUP_VERSION) {
    return { ok: false, error: 'That backup is from a newer Prism. Update Prism, then import it.' };
  }
  const history = Array.isArray(raw.history)
    ? raw.history.filter((h): h is HistoryItem => isObject(h) && typeof h.id === 'string' && typeof h.completedAt === 'string' && isObject(h.metadata))
    : [];
  const subscriptions = Array.isArray(raw.subscriptions)
    ? raw.subscriptions.filter((s): s is Subscription => isObject(s) && typeof s.id === 'string' && typeof s.url === 'string')
    : [];
  return {
    ok: true,
    backup: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
      appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
      // Migrated like settings.json itself, so an older backup gains new keys
      // the same way an older install does.
      settings: migrateSettings(isObject(raw.settings) ? raw.settings : {}),
      history,
      subscriptions,
    },
  };
}

/** Settings after an import: the backup's, except this machine's folders. */
export function mergeSettings(current: AppPreferences, incoming: Partial<AppPreferences>): AppPreferences {
  const merged: AppPreferences = { ...current, ...incoming };
  for (const key of LOCAL_FOLDER_SETTINGS) {
    (merged as unknown as Record<string, unknown>)[key] = current[key];
  }
  return merged;
}

/** The Library after an import: both sets, one entry per id (the newer
 * record wins), newest first, capped like the Library itself. */
export function mergeHistory(current: HistoryItem[], incoming: HistoryItem[]): HistoryItem[] {
  const byId = new Map<string, HistoryItem>();
  for (const item of [...current, ...incoming]) {
    const existing = byId.get(item.id);
    if (!existing || item.completedAt > existing.completedAt) byId.set(item.id, item);
  }
  return [...byId.values()]
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
    .slice(0, HISTORY_CAP);
}

/** Subscriptions after an import: one per feed URL, keeping this machine's
 * copy (and so its record of what was already seen) when both have it. */
export function mergeSubscriptions(current: Subscription[], incoming: Subscription[]): Subscription[] {
  const urls = new Set(current.map(s => s.url));
  const ids = new Set(current.map(s => s.id));
  return [...current, ...incoming.filter(s => !urls.has(s.url) && !ids.has(s.id))];
}

/** What an import will change, for the confirmation dialog. */
export function describeImport(backup: PrismBackup, current: { history: HistoryItem[]; subscriptions: Subscription[] }) {
  const knownHistory = new Set(current.history.map(h => h.id));
  const knownFeeds = new Set(current.subscriptions.map(s => s.url));
  return {
    newLibraryEntries: backup.history.filter(h => !knownHistory.has(h.id)).length,
    newSubscriptions: backup.subscriptions.filter(s => !knownFeeds.has(s.url)).length,
    settings: Object.keys(backup.settings).length > 0,
  };
}
