import { describe, it, expect } from 'vitest';
import { playerFailureHint } from '../player-failure';

// Regression: every failure told macOS users to reinstall, including the
// 2.0.0–2.0.2 hang, where a reinstall changed nothing.
describe('playerFailureHint', () => {
  it('does not suggest a reinstall when the player hung', () => {
    const hint = playerFailureHint('The player stopped responding. Close the player window and restart Prism to play again.', 'mac');
    expect(hint).not.toMatch(/reinstall/i);
    expect(hint).toMatch(/Updates/);
  });

  it('does not suggest a reinstall when mpv refused to start', () => {
    expect(playerFailureHint('Failed to create mpv instance', 'windows')).not.toMatch(/reinstall/i);
  });

  it('suggests a reinstall when the library is missing', () => {
    expect(playerFailureHint('dlopen(/Applications/Prism.app/Contents/Resources/lib/libmpv.dylib): image not found', 'mac')).toMatch(/Reinstalling Prism/);
  });

  it('points Linux at the package manager', () => {
    expect(playerFailureHint('libmpv.so.2: cannot open shared object file', 'linux')).toMatch(/package manager/);
  });
});
