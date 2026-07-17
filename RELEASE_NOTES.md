<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->

## What's New

- **Fixed: the built-in player wouldn't start.** v1.7.1 shipped the embedded player, but a packaging defect (a duplicate library search path) meant it failed to launch on every attempt on macOS. It now works — click the monitor icon on any Library item to play it inside Prism, with full codec support, true HDR, and multichannel audio.
- Hardened the player's startup path against a separate macOS threading issue that could make it hang instead of failing cleanly.

If you already have v1.7.1, this is a quick, worthwhile update.

## Install

**macOS**: Download the `.dmg` file, open it, and drag Prism to Applications. If macOS warns about an unidentified developer, right-click the app and choose "Open".
**Windows**: Download the `.exe` installer and run it. Windows may show a SmartScreen warning — click "More info" then "Run anyway".
**Linux**: The AppImage is the recommended download — `chmod +x` it and run. `.deb` and `.rpm` packages are also attached.
