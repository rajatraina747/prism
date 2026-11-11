import { describe, it, expect } from 'vitest';
import { migrateSettings } from '../settings-migrations';
import { SETTINGS_VERSION } from '@/types/models';

describe('migrateSettings', () => {
  it('has nothing to say about a fresh install', () => {
    expect(migrateSettings(null)).toEqual({});
    expect(migrateSettings(undefined)).toEqual({});
    // A settings file corrupt enough to parse as the wrong kind of thing.
    expect(migrateSettings('nonsense')).toEqual({});
    expect(migrateSettings([1, 2, 3])).toEqual({});
  });

  it('stamps settings written before versioning, keeping what they hold', () => {
    const before = { theme: 'dark', maxConcurrentDownloads: 5 };
    const after = migrateSettings(before);
    expect(after.settingsVersion).toBe(SETTINGS_VERSION);
    expect(after).toMatchObject(before);
  });

  it('leaves settings from a newer Prism alone', () => {
    const future = { settingsVersion: SETTINGS_VERSION + 98, somethingNewer: 'keep me' };
    const after = migrateSettings(future);
    // Not migrated, and above all not stamped back down to this version.
    expect(after).toEqual(future);
  });

  it('keeps keys it knows nothing about', () => {
    const after = migrateSettings({ unknownKey: { nested: true } });
    expect(after).toMatchObject({ unknownKey: { nested: true } });
  });

  it('changes nothing the second time', () => {
    const once = migrateSettings({ theme: 'dark' });
    expect(migrateSettings(once)).toEqual(once);
  });

  it('treats a nonsense version as unversioned rather than trusting it', () => {
    expect(migrateSettings({ settingsVersion: 'two' }).settingsVersion).toBe(SETTINGS_VERSION);
    expect(migrateSettings({ settingsVersion: Number.NaN }).settingsVersion).toBe(SETTINGS_VERSION);
    expect(migrateSettings({ settingsVersion: -3 }).settingsVersion).toBe(SETTINGS_VERSION);
  });

  it('turns the old audio format into the matching audio quality (2.7)', () => {
    expect(migrateSettings({ settingsVersion: 1, audioFormat: 'mp3' }).audioQuality).toBe('mp3-v0');
    expect(migrateSettings({ settingsVersion: 1, audioFormat: 'm4a' }).audioQuality).toBe('m4a');
    expect(migrateSettings({ settingsVersion: 1, audioFormat: 'opus' }).audioQuality).toBe('opus');
    expect(migrateSettings({ settingsVersion: 1 }).audioQuality).toBe('mp3-v0');
    // An older Prism opened on the same file still finds its format.
    expect(migrateSettings({ settingsVersion: 1, audioFormat: 'opus' })).toMatchObject({ audioFormat: 'opus' });
  });

  it('keeps an audio quality already chosen', () => {
    expect(migrateSettings({ settingsVersion: 1, audioFormat: 'opus', audioQuality: 'original' }).audioQuality).toBe('original');
  });
});
