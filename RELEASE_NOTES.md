<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->

## What's New

### Fixes

- **Downloading part of a large torrent no longer fails for lack of space.**
  Prism checked the size of the whole torrent instead of the files you picked,
  so 25 GB from a 150 GB torrent could stop with "Not enough disk space". It
  now checks only what you selected. If a torrent failed this way, retry it
  after updating.
