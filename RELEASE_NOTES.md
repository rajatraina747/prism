<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->

## What's New

Groundwork for 2.4: one queue, stricter engine updates, and current libraries.

### Safer

- **yt-dlp engine updates must be signed by yt-dlp's developers.** Prism checks
  the release's signed checksum list against their published key before it
  uses a new engine, so a tampered download can't replace it.
- The window can no longer start a download directly, only add it to the
  queue, so every download passes the queue's checks.
- Security fixes in the networking libraries Prism uses for updates, feeds
  and direct downloads.

### Fixes

- The queue no longer accepts more downloads at once than the engines can
  run. Before, a high setting made the extra downloads fail as "busy" and
  use up their retries.
- Failed downloads are retried (or not) on the same reading of the error
  everywhere. A message that merely contained "full" or "404" was sometimes
  taken for a full disk or a missing file.
- Downloads of unknown size show as unknown, rather than as 500 MB.
- Statistics no longer says the Library keeps only 2,000 downloads.

### Under the hood

- React 19 and up-to-date dependencies.
- The web demo runs the same queue as the desktop app.

### Known issue

- While a torrent is still seeding, Play and Open on its files may say Prism
  "only does this with files it downloaded". They work once seeding stops
  (stop it from Transfers). A fix is next.
