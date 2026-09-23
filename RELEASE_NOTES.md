<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->
## What's New

Small fixes to the built-in player and to updating.

- **Prism keeps its own Dock icon.** Playing a video used to swap it for the
  player engine's icon until you quit Prism.
- **Updates show their progress.** Settings now shows how much of the update
  has downloaded instead of just "Installing…", and pressing Install again
  no longer starts a second download of the whole app.
- **The player window always closes.** If the player ever gets stuck
  starting, its window can still be closed.
- **Clearer advice when the player can't start.** Prism only suggests
  reinstalling when part of the player is actually missing.

**Updating:** from 1.9.0 or later, use **Settings → Updates**. From 1.8.x or
earlier, run `brew upgrade --cask prism` or download the files below.

## Install

- **macOS:** `brew install --cask rajatraina747/prism/prism` (or `brew upgrade --cask prism`), or download the
  `.dmg`. Not notarized: on macOS 15+ open the app once, then System Settings →
  Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/Prism.app`).
- **Windows:** run the installer; click "More info → Run anyway" on the SmartScreen prompt.
- **Linux:** AppImage, `.deb` or `.rpm`.
