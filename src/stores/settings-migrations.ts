import { SETTINGS_VERSION, type AppPreferences } from '@/types/models';

// Settings on disk outlive the version that wrote them. This turns whatever
// was stored into the shape this build expects, before it is merged over the
// defaults — so a rename never has to be read as "the user unset this".

type Stored = Record<string, unknown>;

/** Each entry migrates settings written by version `index` into `index + 1`. */
const STEPS: ((stored: Stored) => Stored)[] = [
  // 0 → 1: anything written before 2.0 carried no version at all. Nothing in
  // it changed shape, so this only stamps it. The step exists so the next
  // rename has somewhere to go, and so that from then on a stored file says
  // plainly which version wrote it.
  (stored) => stored,
  // 1 → 2 (2.7): the audio format alone became an audio quality. Each old
  // format was at its best quality, which is what it maps to. audioFormat is
  // left in place for an older Prism opened on the same file.
  (stored) => {
    if (stored.audioQuality !== undefined) return stored;
    const format = stored.audioFormat;
    const audioQuality = format === 'm4a' ? 'm4a' : format === 'opus' ? 'opus' : 'mp3-v0';
    return { ...stored, audioQuality };
  },
];

export function migrateSettings(stored: unknown): Partial<AppPreferences> {
  // A fresh install, or a file so corrupt it didn't parse: the defaults are
  // the whole answer.
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};

  const settings = { ...(stored as Stored) };
  const stamp = settings.settingsVersion;
  const from = typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0 ? Math.floor(stamp) : 0;

  // Written by a newer Prism than this one: leave every key exactly as it is.
  // Running this build's migrations over it, or stamping it back down, would
  // quietly destroy whatever that version added — and the user is likely to
  // open the newer one again.
  if (from >= SETTINGS_VERSION) return settings as Partial<AppPreferences>;

  const migrated = STEPS.slice(from, SETTINGS_VERSION).reduce((acc, step) => step(acc), settings);
  return { ...migrated, settingsVersion: SETTINGS_VERSION } as Partial<AppPreferences>;
}
