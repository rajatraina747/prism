<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->
## What's New

- **A finished download never downloads again.** Prism now keeps its own
  record of every download as it finishes, so even if Prism quits at just the
  wrong moment, nothing that already finished starts over when you reopen it.
- **Open, Move to Trash, Convert and Play act only on files Prism
  downloaded.** Prism checks each against its own record rather than taking
  a path on trust. Downloads from before this version are included
  automatically. To play any other file, use **Open file…** in the player.
- **Long queues stay quick.** With more than 100 items, Transfers draws only
  the rows on screen.

**Updating:** from 1.9.0 or later, use **Settings → Updates**. From 1.8.x or
earlier, run `brew upgrade --cask rajatraina747/prism/prism-downloader` or download the files below.

## Install

- **macOS:** `brew install --cask rajatraina747/prism/prism-downloader` (or `brew upgrade --cask rajatraina747/prism/prism-downloader`; never the bare name `prism`, which is GraphPad Prism), or download the
  `.dmg`. Not notarized: on macOS 15+ open the app once, then System Settings →
  Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/Prism.app`).
- **Windows:** run the installer; click "More info → Run anyway" on the SmartScreen prompt.
- **Linux:** AppImage, `.deb` or `.rpm`.
