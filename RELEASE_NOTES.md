<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->

## What's New

- **Fixed: pausing or cancelling a download didn't actually stop it.** yt-dlp runs as two processes — a launcher and the worker that does the downloading — and Prism was only stopping the launcher. The worker carried on in the background: paused items kept using bandwidth and kept filling their files, and quitting Prism left the downloads running with nothing left to stop them. Every stop now takes down the whole process tree, and closing Prism closes its downloads with it.
- **Fixed: some videos downloaded twice, and their progress flickered.** Because a stopped download was still running, starting the item again added a *second* copy alongside the first. Both reported progress for the same row, which is why the bar jumped between two different sizes and percentages — and why duplicate `(1)`/`(2)` files piled up in the download folder. Prism now runs exactly one download per queue item.
- **Fixed (Windows): the sidebar stopped working when a magnet link launched the app.** Every sidebar click bounced straight back to the Dashboard, usually with an "already in your queue" message. Navigation works normally now.

**Upgrading?** If you've seen the flickering progress bar, you may have stray `yt-dlp` processes still downloading in the background from an earlier version. Restarting your computer clears them. Duplicate `... (1)`/`(2)` part-files left behind in your download folder are safe to delete.

## Install

**macOS**: Download the `.dmg` file, open it, and drag Prism to Applications. If macOS warns about an unidentified developer, right-click the app and choose "Open".
**Windows**: Download the `.exe` installer and run it. Windows may show a SmartScreen warning — click "More info" then "Run anyway".
**Linux**: The AppImage is the recommended download — `chmod +x` it and run. `.deb` and `.rpm` packages are also attached.
