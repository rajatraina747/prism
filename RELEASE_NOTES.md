<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->
## What's New

<!-- Next release draft: fill in as fixes land (ROADMAP). -->

### Fixed

- **A removed torrent's folder no longer reappears.** A torrent that finished
  before 2.0.1 and was later removed from the Library stayed in the torrent
  engine's saved session, so every launch re-created its folder in your
  download location, full of empty files. At launch Prism now drops any saved
  torrent no queue item refers to. Nothing you downloaded is touched; you can
  delete an empty folder that was already re-created.

**Updating:** from 1.9.0 or later, use **Settings → Updates**. From 1.8.x or
earlier, run `brew upgrade --cask rajatraina747/prism/prism-downloader` or download the files below.

## Install

- **macOS:** `brew install --cask rajatraina747/prism/prism-downloader` (or `brew upgrade --cask rajatraina747/prism/prism-downloader`; never the bare name `prism`, which is GraphPad Prism), or download the
  `.dmg`. Not notarized: on macOS 15+ open the app once, then System Settings →
  Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/Prism.app`).
- **Windows:** run the installer; click "More info → Run anyway" on the SmartScreen prompt.
- **Linux:** AppImage, `.deb` or `.rpm`.
