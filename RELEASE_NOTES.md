<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->

## What's New

- **The built-in player is here (macOS & Windows).** Play anything you've downloaded without leaving Prism — click the monitor icon on any Library item, or on any single file inside a torrent. Powered by an embedded mpv, so it plays what your system player can't: every codec and container (HEVC, VP9, AV1, mkv, webm), **true HDR** on HDR displays, multichannel audio with proper downmixing, and subtitle/audio track switching. Seek, volume, speed, fullscreen, keyboard shortcuts, and badges that tell you exactly what you're watching (resolution, HDR, 5.1). You can also open any local media file from inside the player.
- Prism's downloads bundle everything the player needs — nothing to install, no dependencies.
- Linux: the player arrives in a later release (the embedding layer isn't ready on Linux yet); everything else works as before.

This builds on v1.7.0's honesty fixes: your chosen resolution is what gets downloaded (including 4K/HDR tiers), with a warning whenever a site delivers less.

## Install

**macOS**: Download the `.dmg` file, open it, and drag Prism to Applications. If macOS warns about an unidentified developer, right-click the app and choose "Open".
**Windows**: Download the `.exe` installer and run it. Windows may show a SmartScreen warning — click "More info" then "Run anyway".
**Linux**: The AppImage is the recommended download — `chmod +x` it and run. `.deb` and `.rpm` packages are also attached.
