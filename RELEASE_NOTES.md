<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->

## What's New

- **Your chosen quality is now actually downloaded** — picking 2160p/1440p used to silently deliver 1080p on YouTube (the H.264-compatibility preference outranked your resolution choice, and YouTube's H.264 stops at 1080p). The chosen resolution now wins, in whatever codec the site offers it — including YouTube's 4K and HDR tiers.
- **No more silent quality downgrades** — every download now records the resolution that was *actually* delivered. If it falls short of what you asked for, you get a warning the moment the download finishes, and the Library shows it in amber ("1080p (asked 2160p)") instead of repeating the label you clicked.
- **Torrent downloads are reachable from the Library again** — torrents that write files straight into the download folder (no wrapper folder) used to complete with no Play/Show-in-Folder buttons at all; their paths now resolve correctly.
- **Per-file access for torrents** — completed torrents in the Library expand into their file list, and every file has its own play, open, and reveal buttons. No more digging through Finder for episode 3.
- **Older torrent entries** recorded without a path now get a Show-in-Folder button pointing at their download folder.

Also in this release: the groundwork for an embedded video player (all codecs, HDR, multichannel audio, powered by mpv). It runs in development builds today and ships to everyone once packaging is done — see ROADMAP.md.

## Install

**macOS**: Download the `.dmg` file, open it, and drag Prism to Applications. If macOS warns about an unidentified developer, right-click the app and choose "Open".
**Windows**: Download the `.exe` installer and run it. Windows may show a SmartScreen warning — click "More info" then "Run anyway".
**Linux**: The AppImage is the recommended download — `chmod +x` it and run. `.deb` and `.rpm` packages are also attached.
