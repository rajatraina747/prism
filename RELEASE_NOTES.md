<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->

## What's New

- **Torrent pause & resume actually works** — resuming a paused torrent picks up the pieces already on disk instead of failing with a file error
- **Stopping a seed counts as a success** — a fully downloaded torrent now lands in your library as completed (with Play and Show in Folder), not "canceled"
- **New Library page** — Completed, Failed, and Canceled downloads live in one place with tabs, search, and failure reasons with one-click retry; the sidebar shows a badge when something fails
- **Playlists queue instantly** — importing a playlist adds every selected video in one click instead of parsing them one by one while you wait
- **System notifications** — get notified when a download finishes or fails while Prism is minimized or in the tray
- **Pick a folder per download** — the download dialog's Advanced section now has a Change button for the destination
- **Video or playlist?** — pasting a watch link that's part of a playlist now asks which one you meant
- **ffmpeg check** — Settings warns you (with install instructions) if ffmpeg is missing, instead of features silently not working
- Remembered per-site quality presets now work as intended
- Magnet links are no longer skipped when pasting a list of URLs
- Splash screen only shows on first launch; the window remembers its size and position
- URL parsing can no longer hang forever on a dead site — it times out with a clear message
- Downloads of videos with non-Latin titles (Japanese, Hindi, …) from subscriptions keep their real names
- Sharper error messages: the real cause is shown instead of the last log line, and unknown errors no longer retry pointlessly
- Accessibility: visible keyboard focus, larger text, screen-reader labels everywhere, and queue reordering via keyboard (focus the drag handle, use arrow keys)
- Queue and history files are written crash-safely, YouTube link variants (youtu.be / shorts / watch) de-duplicate correctly, and duplicate-quality listings no longer double-highlight

## Install

**macOS**: Download the `.dmg` file, open it, and drag Prism to Applications. If macOS warns about an unidentified developer, right-click the app and choose "Open".
**Windows**: Download the `.exe` installer and run it. Windows may show a SmartScreen warning — click "More info" then "Run anyway".
**Linux**: The AppImage is the recommended download — `chmod +x` it and run. `.deb` and `.rpm` packages are also attached.
