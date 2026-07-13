<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->

## What's New

- **Drag-to-reorder actually drops** — reordering the queue silently did nothing because the app's native drag handler was swallowing the drop; dragging URLs into the window works properly now too
- **Steady progress for merged downloads** — video + audio downloads no longer snap back to 0% halfway through; the bar and byte counts only move forward, and a "Processing — merging & finishing up…" label shows while ffmpeg works (long merges are no longer killed as inactive)
- **Fixed "No such file or directory" at the end of a download** — two downloads of the same video could share temp files and destroy each other's merge; each download now claims its own filenames up front
- **Instant torrent pause/resume** — pausing keeps the torrent in the engine, so resuming no longer re-checks gigabytes of data on disk; Pause All / Resume All handle torrents and seeds correctly
- **Torrents only fail when the swarm is actually dead** — a torrent with connected peers waits patiently (like every other client) instead of giving up after 5 quiet minutes; resumes no longer die during the startup hash-check
- **Swarm health at a glance** — queue rows now distinguish "searching for peers", "connecting…", "0 of 40 peers reachable" (a firewall hint) and "12 peers · 45 seen"
- **Change file selection mid-torrent** — the file list in a queue row now has checkboxes; skip or add files while it downloads
- **Extra trackers** — add announce URLs (Settings → Downloads) to every torrent, for magnets whose own trackers are dead
- **Per-download speed limit now applies to torrents** — on top of the session-wide Quiet Hours cap
- **IP blocklist** — point Settings at a standard p2p blocklist URL to keep known-bad peers out (applies on next launch)
- **Copy link** — every queue row can copy its magnet or source URL

## Install

**macOS**: Download the `.dmg` file, open it, and drag Prism to Applications. If macOS warns about an unidentified developer, right-click the app and choose "Open".
**Windows**: Download the `.exe` installer and run it. Windows may show a SmartScreen warning — click "More info" then "Run anyway".
**Linux**: The AppImage is the recommended download — `chmod +x` it and run. `.deb` and `.rpm` packages are also attached.
