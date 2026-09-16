<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->
## Prism 2.0 — Download manager

Prism started as a way to save a video. This release makes it something you can
leave running: a queue that sorts its own downloads, subscriptions that fetch
by themselves, and a player that opens the file without leaving the app.

### Downloads

- **Direct file links.** Disk images, archives, installers and documents now
  download through Prism's own engine — several connections at once, resuming
  where it stopped, and an optional SHA-256 it checks before calling the file
  finished.
- **Torrents** sit in the same queue as everything else, with per-file
  selection, seeding limits, and a **Play now** that streams a file while the
  rest is still arriving.
- **Part of a video.** Give a start and end time (`1:23`, `0:01:23`) and Prism
  fetches just that stretch, cutting where you asked rather than at the nearest
  keyframe. Or split a long video into one file per chapter.
- **Categories and labels** file downloads as they arrive — by site, file type
  or engine — each with its own folder and file-name template. Finished
  downloads can move somewhere else automatically.
- **Watch folders.** Drop a `.torrent` or a text file of links into a folder
  and Prism picks it up.

### Getting on with it

- **Quiet hours**, now per weekday: hold new downloads or slow them between two
  times. An overnight window belongs to the evening it started on.
- **Start a download later** without holding up the rest of the queue.
- **When everything finishes**, Prism can sleep or shut down the machine, after
  a minute's countdown you can call off. Seeding counts as work, so nothing
  sleeps mid-upload.
- **Per download**, choose what happens when it finishes: notify, open, or show
  in the folder.
- **Dock and taskbar progress** while downloads run.
- **Optional global shortcuts** for add-from-clipboard, show Prism, and pause
  everything. Off unless you assign them — a system-wide shortcut is taken from
  every other app.
- **A proper menu bar**, with ⌘1–⌘5 for the pages and ⌘N to add.

### Subscriptions

- **RSS and Atom feeds** alongside channels and playlists. Podcast and torrent
  feeds work, because Prism takes the enclosure rather than the page it's
  described on.
- **Keyword rules** per feed, and a category everything from it is filed under.
  A video the rules turn down is remembered as seen, so loosening a rule later
  doesn't pull in the back catalogue.

### The library

- **Sort, search, and a grid view** that leads with the thumbnail, plus a
  compact density for more rows on screen.
- **Select several at once** to re-download, reveal, remove, or **move to the
  Trash** — recoverable there, unlike a delete.
- **Already had this?** When a download finishes, Prism says so if the same
  file has landed before under another name or from another URL.
- **Statistics**: what you've downloaded, by engine, site, category and day.

### The player

- Plays what torrents actually contain — HEVC, VP9, AV1, mkv, HDR, surround —
  and **remembers where you stopped**.
- Chapters, external subtitles with timing offset, and a mini player that stays
  on top.
- **Video works on every Mac now.** Prism bundles the graphics driver it needs
  rather than hoping one is installed.

### Under it

- **ffmpeg is included.** Merging, audio extraction and SponsorBlock work out
  of the box, with no separate install. The bundled build is LGPL, built from
  pinned sources; the corresponding source is published alongside each release.
- **The downloader engine updates itself**, separately from Prism, and tells
  you when it's behind.
- **Failures explain themselves** — a reason, and where possible a button that
  fixes it.
- **Downloads no longer outlive the app.** Closing Prism stops its work rather
  than leaving it running in the background.

### Updating

Prism's data has moved to a new location. The first launch copies it across and
leaves the old copy untouched. Your downloads, history, settings and
subscriptions come with you; macOS and Windows may ask again for notification
permission.

- From 1.9.x, use **Settings → Updates**.
- From 1.8.x or earlier, `brew upgrade --cask prism` or download below.

## Install

- **macOS:** `brew install --cask rajatraina747/prism/prism` (or `brew upgrade --cask prism`), or download the
  `.dmg`. Not notarized: on macOS 15+ open the app once, then System Settings →
  Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/Prism.app`).
- **Windows:** run the installer; click "More info → Run anyway" on the SmartScreen prompt.
- **Linux:** AppImage, `.deb` or `.rpm`.
