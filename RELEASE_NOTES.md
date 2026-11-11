<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->

## What's New

### Fixes

- **No more crash after using the player with AirPods (macOS).** After you
  played something on AirPods, Prism could quit unexpectedly the next time your
  audio device changed, such as when you took them out, even with the player
  long closed.
- **Updated SQLite.** The library Prism stores its data with is now a version
  that includes a recent upstream security fix.

### Interface

- **A new About window.** About Prism now opens a window in Prism's own design,
  with the version, an update check, and links to release notes, bug reports
  and licenses.
- **Steadier Transfers.** The stats under a running download stay on one line
  instead of making the row jump, and the peers table now fits its panel.
