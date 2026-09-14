<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->
## What's New

A fix release for two bugs found in real use of 1.8.0, plus a few small
hardening items from the follow-up review (`docs/REVIEW-2026-09-14.md`).

**Finished downloads reach the Library again.** In 1.8.0 a download that
completed while any other transfer was still running never moved to the
Library — and since the Transfers page hides finished rows, it simply
vanished. Anything stuck that way is archived on the first launch of this
version.

**Multi-file torrents get their own folder.** A torrent without a root folder
of its own (many episode and race packs) used to write its files straight into
the download folder, so two packs with the same inner file names — for
example `02.Race.Session.mp4` in two F1 weekends — wrote into the *same file*
and corrupted each other. Every multi-file torrent now downloads into
`<download folder>/<torrent name>/`, like every other client; single-file
torrents are unchanged. Prism also refuses to add a torrent whose folder is in
use by a different one.

> If you added multi-file torrents with 1.8.0: they will restart from scratch
> into their new folders on relaunch. Delete the loose files they left in your
> download folder by hand — don't use "Remove and delete files" on them, since
> two such torrents share those files.

**Hardening.**
- yt-dlp now runs with `--ignore-config --no-plugin-dirs`, so a config file or
  plugin elsewhere on the machine can't change what Prism asked for.
- "Open" and the player resolve symlinks *before* checking that a file is
  media, so a link named `clip.mp4` can't smuggle in something else.
- Dropping a link onto the URL box no longer submits it twice.
- Light mode: status colours and sidebar hover states now have proper contrast.
- Settings are written to disk 300 ms after the last change instead of on
  every keystroke.

**Docs.** The README now states the ffmpeg requirement up front, and no longer
claims an Intel macOS build (there is none; the Apple Silicon build is the
only macOS build).

## Install

- **macOS:** `brew install --cask rajatraina747/prism/prism`, or download the
  `.dmg`. Not notarized: on macOS 15+ open the app once, then System Settings →
  Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/Prism.app`).
- **Windows:** run the installer; click "More info → Run anyway" on the SmartScreen prompt.
- **Linux:** AppImage, `.deb` or `.rpm`.
