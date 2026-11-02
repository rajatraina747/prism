<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->

## What's New

A fix for torrents that are still seeding.

### Fixes

- **Play and Open work on a torrent as soon as it has downloaded**, not only
  after seeding ends. Before, they were refused ("only does this with files it
  downloaded") for as long as the torrent kept seeding, which with "seed
  forever" was never.
- A multi-file torrent's files can be opened, played and shown in the folder
  from the Transfers detail panel while the rest is still downloading. The
  panel used to look for them one folder too high.
- Library no longer offers "Play in Prism" for a multi-file torrent's folder,
  where it always failed. Each file in the expanded list still has its own
  play button.
- A proxy password you have removed from Settings no longer stays on disk, and
  a failed playlist lookup no longer logs a link's credentials.
