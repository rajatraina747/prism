<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->
## What's New

Prism 2.0.1 fixes bugs that could lose your queue, keep torrents uploading
after they finished, or put more than you meant in the Trash. Update if you're
on 2.0.0.

- **The queue is saved while downloads run.** In 2.0.0 it was saved only when
  nothing was downloading. If you quit during a batch, everything that
  finished since the last quiet moment downloaded again next time, and links
  you added meanwhile were gone.
- **Finished torrents stop uploading.** A torrent that met its seeding limit
  showed as Completed but kept seeding, and started again at every launch
  with nothing on screen to show it. Torrents already caught this way are
  paused when Prism starts; your files are not touched.
- **Move to Trash only takes the download itself.** For some single-file
  torrents, Prism recorded the whole download folder as the file, so moving
  that item to the Trash moved every download with it. Prism now refuses to
  trash your download folders, your home folder or any folder that contains
  them, and the confirmation names any folder it is about to trash.
- **Two direct downloads with the same file name no longer overwrite each
  other.** The second one now gets its own name, such as `download (1)`.
- **Quitting stops conversions.** ffmpeg used to keep running after Prism
  closed.
- **Folders with `%` in their name work.** A destination such as `100% Music`
  made every video download fail. A video whose title contained `%` also
  finished without Play or Show in Folder.

**Updating:** from 1.9.0 or later, use **Settings → Updates**. From 1.8.x or
earlier, run `brew upgrade --cask prism` or download the files below.

## Install

- **macOS:** `brew install --cask rajatraina747/prism/prism` (or `brew upgrade --cask prism`), or download the
  `.dmg`. Not notarized: on macOS 15+ open the app once, then System Settings →
  Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/Prism.app`).
- **Windows:** run the installer; click "More info → Run anyway" on the SmartScreen prompt.
- **Linux:** AppImage, `.deb` or `.rpm`.
