<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->
## What's New

### Back up and move Prism

**Settings → Storage → Back up settings and Library.** Export saves your
settings, Library and subscriptions to one file; Import brings them back, on
this Mac or another. Import adds to what's there and never removes anything.
Your download and watch folders stay as they are on the Mac you import on.

### Bring your torrents from qBittorrent or Transmission

**Settings → BitTorrent → Import torrents.** Pick the other app's folder and
Prism adds its torrents, paused, pointed at the files that app already
downloaded. When you start one, Prism checks those files first instead of
downloading them again. Quit the other app before you start them.

### Fewer duplicate downloads

Prism now recognises the same video behind two different links on any site
the downloader supports, not just YouTube, and tells you when it's already in
your queue or Library.

### Homebrew

The Homebrew cask is now **`rajatraina747/prism/prism-downloader`**. Homebrew's
own catalogue has a different app called `prism` (GraphPad Prism), and a bare
`brew upgrade --cask prism` installs that instead. If you installed Prism with
Homebrew, run `brew update`, then
`brew migrate --cask rajatraina747/prism/prism-downloader` once. If Homebrew
says the tap is untrusted, run `brew trust rajatraina747/prism` first.

**Updating:** from 1.9.0 or later, use **Settings → Updates**. From 1.8.x or
earlier, run `brew upgrade --cask rajatraina747/prism/prism-downloader` or download the files below.

## Install

- **macOS:** `brew install --cask rajatraina747/prism/prism-downloader` (or `brew upgrade --cask rajatraina747/prism/prism-downloader`; never the bare name `prism`, which is GraphPad Prism), or download the
  `.dmg`. Not notarized: on macOS 15+ open the app once, then System Settings →
  Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/Prism.app`).
- **Windows:** run the installer; click "More info → Run anyway" on the SmartScreen prompt.
- **Linux:** AppImage, `.deb` or `.rpm`.
