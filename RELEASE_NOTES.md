<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->

## What's New

A safety release. Every fix here came out of a ground-up review of 2.3.0.

### Cancel never touches files that aren't the download's own

- **Cancelling a download could delete a different file.** Prism looked for
  files that merely *started* with the download's name, so cancelling
  "Episode 1" could delete a finished "Episode 1.5 Special.mp4" beside it. A
  cancel now removes only the files that download wrote, matched exactly.
- Leftover partial pieces are deleted. Anything that could be a finished file
  goes to the Trash instead, so a mistake there can be undone.
- **A torrent no longer writes into a folder it doesn't own.** A second pack
  with the same name as one you already have (a "Season 1", say) now gets a
  folder of its own instead of overwriting the first.

### Fixes

- **Sleep or shut down "when everything finishes" is called off** if you add
  something during the one-minute countdown. Before, the Mac could go to
  sleep with a download running.
- **Downloads added with "Start immediately" turned off can now be started**
  (Start on the row, in its menu, or with Resume). Before, nothing could start
  them, and one of them stopped "when everything finishes" from ever happening.
- Pausing and resuming a download while it waited to retry could start a
  second copy of it. Fixed.
- A torrent that failed or hit the "give up" limit kept downloading in the
  background with no row to stop it. It now stops.
- Statistics no longer grow each time Prism starts. Totals already counted
  twice stay as they are.
- On Transfers, Enter and Space work on the focused button again, and do
  nothing behind a confirmation dialog.
- Fixed a crash that could happen when closing the player.
- **Browser extension 1.2.1:** the toolbar button works again.
