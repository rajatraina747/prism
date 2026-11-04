<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->

## What's New

Prism's player now plays any video or audio file on your computer, not just your downloads.

- **Play a File** (⌘O, or the button under Add in the sidebar): pick any video
  or audio file, including ones on an external drive or a network share. You
  can also drop a file onto the player window, and add subtitles from any
  folder.
- **Default quality** in Settings → Video replaces the Dashboard's Quick
  Presets. It's remembered, and it's used for playlists and batches and
  pre-selected in the quality list. A site you've used before starts with the
  quality you picked there last.
- **A shorter quality list:** one row per resolution, with 60 fps shown when
  it's available. Vertical videos no longer list the same sizes twice under
  names like "1920p" and "854p".
- **Make videos play on Apple devices** is now a setting (Settings → Video). It's on
  by default on Mac and off on Windows and Linux. The re-encode shows its
  progress, and it skips videos above 1080p when only a slow software encoder
  is available.

### Fixes

- **The downloader engine no longer re-downloads itself on every launch.**
  Since 2.3.1, a file Prism wrote while checking for engine updates made the
  updated engine fail its own integrity check at the next start. Prism then
  fell back to the older built-in engine and downloaded the update again.
  Existing installs are fixed on first launch. Leftover copies from
  interrupted updates (about 120 MB each) are cleaned up too.
- **The player no longer gives up when its first start is slow.** It used to
  report "The player stopped responding" and stay broken until Prism was
  restarted.
