<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->
## What's New

A security and reliability release, from an independent review of the
whole app.

### Safer torrents and watch folders

- **A torrent can no longer overwrite a file that's already there.** A
  single-file torrent whose name matches a file already in your download
  folder, or that has a hidden name, now goes into a folder of its own
  instead of writing over that file.
- **A `.torrent` found in a watch folder now asks before it starts.** Browsers
  save `.torrent` files to Downloads without asking, so a web page could
  otherwise start a torrent on your behalf.
- **Your home folder itself, system folders and folders programs run from**
  (such as `/opt/homebrew/bin`) can no longer be download locations. Pick or
  create a folder inside them instead.

### Subscriptions and privacy

- **Subscription downloads from other sites no longer use your browser's
  cookies.** Items on the subscription's own site still do. A feed's links to
  your local network (a router, `localhost`, `.local` names) are skipped.
- **With a proxy set,** update checks now go through it, UPnP is switched off,
  and thumbnails aren't shown, because they would be fetched directly.
- **Crash reports** (if you turned them on) no longer include your computer's
  name, and file paths are removed wherever the file lives.

### Fixed

- **Split chapters** are now saved next to the video, not in the app's
  working folder.
- **Converting the same file twice at once** no longer deletes the first
  result.
- **Finishing large downloads** no longer makes the rest of the app stall while
  files are moved or checked.
- **A removed torrent's folder no longer reappears.** A torrent that finished
  before 2.0.1 and was later removed from the Library stayed in the torrent
  engine's saved session, so every launch re-created its folder in your
  download location, full of empty files. At launch Prism now drops any saved
  torrent no queue item refers to. Nothing you downloaded is touched; you can
  delete an empty folder that was already re-created.
- A direct download from a server that never says the file's size now stops
  before your disk fills up.

**Updating:** from 1.9.0 or later, use **Settings → Updates**. From 1.8.x or
earlier, run `brew upgrade --cask rajatraina747/prism/prism-downloader` or download the files below.

## Install

- **macOS:** `brew install --cask rajatraina747/prism/prism-downloader` (or `brew upgrade --cask rajatraina747/prism/prism-downloader`; never the bare name `prism`, which is GraphPad Prism), or download the
  `.dmg`. Not notarized: on macOS 15+ open the app once, then System Settings →
  Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/Prism.app`).
- **Windows:** run the installer; click "More info → Run anyway" on the SmartScreen prompt.
- **Linux:** AppImage, `.deb` or `.rpm`.
