<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->
## What's New

**The built-in player works again on Macs.** Since 2.0, Play in Prism did
nothing on macOS: the player could not start. This release fixes that.

### Fixes

- **Stopping a download right after adding it now stops it.** Removing a
  magnet while Prism was still fetching its details used to let it download
  and keep seeding in the background, with nothing on screen to show it.
- **Downloads land where Prism can find them.** On Windows, a video whose
  title contained characters such as `:` or `?` finished without Play or
  Show in Folder. Prism now asks the downloader for the file's real path.
- **Titles with `%` keep their name.** `100% Pure` was saved as
  `100%% Pure.mp4`.
- **A server that sends the wrong part of a file is caught** instead of
  quietly corrupting a direct download.
- **The duplicate-content index can no longer be wiped** when several
  downloads finish at the same moment.
- **Turning off notifications or sounds applies straight away**, including
  to downloads already running.
- **Smoother while downloading.** Progress updates no longer redraw the
  whole app several times a second.

### Security

- **Watch folders ask before adding links from a text file.** If you watch
  your Downloads folder, a web page could otherwise drop in a text file of
  links and Prism would fetch them unasked. A `.torrent` you drop in is
  still added straight away. Text files with no links in them are left
  exactly as they are, and Prism won't watch the folder it downloads into.
- **Subscriptions use your SOCKS proxy.** Feed checks used to go around it.
- **The player can't reach the network through a disguised file.** A
  torrent file that was really a playlist could make the player fetch
  whatever it listed.
- **The player window can only use the player.** It could previously call
  any of Prism's commands.


**Updating:** from 1.9.0 or later, use **Settings → Updates**. From 1.8.x or
earlier, run `brew upgrade --cask prism` or download the files below.

## Install

- **macOS:** `brew install --cask rajatraina747/prism/prism` (or `brew upgrade --cask prism`), or download the
  `.dmg`. Not notarized: on macOS 15+ open the app once, then System Settings →
  Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/Prism.app`).
- **Windows:** run the installer; click "More info → Run anyway" on the SmartScreen prompt.
- **Linux:** AppImage, `.deb` or `.rpm`.
