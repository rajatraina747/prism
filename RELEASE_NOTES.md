<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->

## What's New

A big release: faster, more honest about what you're getting, and much
harder to lose work in. It was built from a ground-up review of 2.2.1 and
tested by hand on Windows before release.

### Faster

- **Links are looked up much faster.** The bundled download engine now starts
  in a fraction of a second instead of about five (macOS and Windows), so a
  YouTube lookup takes around 3 s instead of 9. Batches of links are looked up
  four at a time, and a download reuses the lookup made when it was added.
- **Slow connections no longer hold up a direct download.** When one part of
  a file is crawling, the rest of it is shared out to the connections that
  have finished.

### Quality, audio and subtitles

- **Quality choices say what you'll actually get:** the real codec (H.264,
  VP9, AV1), frame rate and HDR, instead of "MP4 h264/aac" for everything.
- **Choose a dubbed audio track,** and pick several subtitle languages; they
  are embedded in the video.
- **Playlists and channels** keep each video's own link and the list's real
  title, and one lookup decides whether a link is a single video or a list.
  Lists with more than 100 entries open with nothing selected.
- Sites that don't report a video codec (such as archive.org) now offer their
  qualities, and links Prism doesn't recognise download as plain files.

### Keeps working, and keeps your data

- **Closing the window keeps downloads running** in the tray (you can turn
  this off), and Prism asks before quitting while work is in progress.
- **The queue and Library now live in a database** that Rust keeps up to date
  as things happen, so a crash or forced quit no longer loses recent changes.
  Your existing data is copied in on the first launch and the old files are
  kept. A backup is made on each clean launch and restored automatically if
  the database is ever damaged.
- **"Retries on failure" now works,** and a site that rate-limits you is
  retried after a proper wait, with a countdown on the row. A site that refuses
  a download halfway is looked up again instead of failing.
- **Cancel removes what the download wrote,** including partial files and
  empty folders.
- The Library marks files that were moved or deleted outside Prism.

### Torrents, subscriptions and more

- **Torrents have their own limit,** and a stalled or peerless one no longer
  blocks other downloads. Downloaded torrents appear in the Library, marked
  Seeding.
- If another program is using the torrent port, Prism picks another; you can
  restart the torrent engine from Settings to apply changed settings.
- **YouTube subscriptions are checked much faster** (three at a time), skip
  videos you already have, and wait for premieres and live streams to air.
- Watch folders pick up `.torrent` files only.
- Direct downloads work through a SOCKS proxy, can send the page they came
  from, and can use a browser's User-Agent for sites that need one.
- Thumbnails are kept on your computer (and fetched through your proxy).
- **Browser extension 1.2:** "Download link in Prism" sends the page the link
  was on, for sites that check it.

### Windows

- Fixed Play, Open, Move to Recycle Bin and the Missing badge, which failed on
  Windows because of how file paths were compared.
- Notifications work again after updating; the old engine file is removed.
- Windows wording throughout (Recycle Bin, "this computer").

**Updating:** use **Settings → Updates**, or run
`brew upgrade --cask rajatraina747/prism/prism-downloader`. After updating,
going back to 2.2.1 would show your queue and Library as they were before the
update.

## Install

- **macOS:** `brew install --cask rajatraina747/prism/prism-downloader` (or `brew upgrade --cask rajatraina747/prism/prism-downloader`; never the bare name `prism`, which is GraphPad Prism), or download the
  `.dmg`. Not notarized: on macOS 15+ open the app once, then System Settings →
  Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/Prism.app`).
- **Windows:** run the installer; click "More info → Run anyway" on the SmartScreen prompt.
- **Linux:** AppImage, `.deb` or `.rpm`.
