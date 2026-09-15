<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->
## What's New

**The built-in player now works on every Mac.** Prism's player draws video
through Vulkan, which macOS doesn't provide by itself. Prism shipped without
the driver that fills that gap (MoltenVK), so the player only showed video on
Macs that already had it through Homebrew; everywhere else the video never
started. Prism now includes the driver. Windows and Linux were not affected.

**Also included from 1.9.1:** opening the player no longer freezes the whole
app.

**Updating:** from 1.9.0 or 1.9.1, use **Settings → Updates**. From 1.8.x or
earlier, run `brew upgrade --cask prism` or download the files below.

## Install

- **macOS:** `brew install --cask rajatraina747/prism/prism` (or `brew upgrade --cask prism`), or download the
  `.dmg`. Not notarized: on macOS 15+ open the app once, then System Settings →
  Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/Prism.app`).
- **Windows:** run the installer; click "More info → Run anyway" on the SmartScreen prompt.
- **Linux:** AppImage, `.deb` or `.rpm`.
