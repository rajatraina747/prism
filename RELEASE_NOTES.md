<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->
## What's New

**The built-in player on Macs, fixed properly this time.** 2.0.2 still
passed the player one setting its engine doesn't have, so Play in Prism kept
failing with "The player engine failed to start". This release removes it.

If the player window from an earlier attempt won't close, quit Prism (⌘Q)
and open it again.

**Updating:** from 1.9.0 or later, use **Settings → Updates**. From 1.8.x or
earlier, run `brew upgrade --cask prism` or download the files below.

## Install

- **macOS:** `brew install --cask rajatraina747/prism/prism` (or `brew upgrade --cask prism`), or download the
  `.dmg`. Not notarized: on macOS 15+ open the app once, then System Settings →
  Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/Prism.app`).
- **Windows:** run the installer; click "More info → Run anyway" on the SmartScreen prompt.
- **Linux:** AppImage, `.deb` or `.rpm`.
