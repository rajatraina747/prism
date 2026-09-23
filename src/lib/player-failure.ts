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
      ? "Prism's player needs libmpv. Install it from your package manager (e.g. libmpv2), then reopen the player."
      : 'Part of the player is missing from this copy of Prism. Reinstalling Prism should restore it.';
  }
  return 'This is a problem in Prism, not in your video or your installation. Check Settings → Updates for a newer version. If it keeps happening, Settings → Diagnostics → Export logs gives you a file to attach to a bug report.';
}
