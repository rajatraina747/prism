<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->
## What's New

**The built-in player works again on macOS.** Opening a video in Prism's
player could freeze the whole app with a spinning cursor until you force-quit
it. Prism asked the video engine to start playback on the same thread macOS
needs for setting up the video window, so each waited for the other forever.
Prism now talks to the video engine from a thread of its own. If the engine
ever stops responding, the player says so and the rest of Prism keeps working.
Closing the player while a video is still opening no longer freezes it either.

**Also in the player:** if a file can't be opened, the player now shows why.
Its "failed to start" screen no longer suggests installing mpv with Homebrew.
Prism only ever uses its own copy, so reinstalling Prism is the fix.

**Updating:** from 1.9.0, use **Settings → Updates**. From 1.8.x or earlier,
run `brew upgrade --cask prism` or download the files below.

## Install

- **macOS:** `brew install --cask rajatraina747/prism/prism` (or `brew upgrade --cask prism`), or download the
  `.dmg`. Not notarized: on macOS 15+ open the app once, then System Settings →
  Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/Prism.app`).
- **Windows:** run the installer; click "More info → Run anyway" on the SmartScreen prompt.
- **Linux:** AppImage, `.deb` or `.rpm`.
