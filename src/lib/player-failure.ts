import { t } from '@/i18n';
// What to tell someone whose player failed to start. The screen used to say
// "reinstalling Prism should restore it" for every failure on macOS and
// Windows, but a reinstall only helps when the player's library is missing or
// damaged. When mpv hung or refused its settings (2.0.0 to 2.0.2), the fault
// was in Prism itself and a reinstall changed nothing.

export type Platform = 'mac' | 'windows' | 'linux';

const LIBRARY_MISSING = /dlopen|not loaded|image not found|library load failed|cannot open shared object|LoadLibrary|isn't included in this build/i;

export function playerFailureHint(error: string, platform: Platform): string {
  if (LIBRARY_MISSING.test(error)) {
    return platform === 'linux'
      ? t('player.failure.linux')
      : t('player.failure.missing');
  }
  return t('player.failure.bug');
}
