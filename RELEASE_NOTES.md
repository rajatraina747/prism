<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->
## What's New

A hardening release, following an outside security, product and licensing
review (see `docs/AUDIT-2026-09.md`).

**Downloads go where you want.** Pick any folder — an external drive, a NAS,
a symlinked Downloads — and Prism now accepts it. In return, system locations
inside your home folder (Library, AppData, dotfiles like `.ssh`) can never
receive a download or be opened from the app, whatever a torrent's file names say.

**Faster and less fragile.**
- Segmented (HLS/DASH) downloads now fetch four fragments in parallel.
- Cancelling a metadata fetch kills the whole yt-dlp process tree, not just the launcher.
- Progress updates are rate-limited, so ten parallel downloads no longer make the UI stutter.
- New: "Keep original container" (Settings → Downloads) leaves VP9/AV1 in mkv/webm instead of forcing .mp4.

**Torrents: never give up, and a proper client.**
- A torrent with no peers **no longer fails after 5 minutes**. It stays live,
  shows how long it has been searching, and re-announces to trackers, DHT and
  the local network every 5 minutes — like uTorrent and Vuze. An optional
  "give up after N minutes" setting exists for people who want the old
  behaviour (off by default).
- **Update tracker** (row button, context menu, or `R`) forces a fresh announce
  without re-checking data. **Force re-check** re-hashes everything on disk.
  **Remove and delete files** removes the data too (with a confirmation).
- **Restarts resume in seconds**: the engine now persists its session and
  piece maps, so a relaunch spot-checks instead of re-hashing gigabytes.
- **Retry shows the real size** (no more 476.8 MB placeholder): resolved
  torrent metadata is cached, so a retried magnet knows its size and files
  with zero peers.
- **Detail panel** under the list (click a row, then Details / Enter): pieces
  map, info hash, save path, lifetime upload and ratio; **Files** tab with a
  folder tree, per-file progress, select/deselect and Play/Open/Reveal;
  **Peers** tab with client, transport, speeds and totals; **Trackers** tab;
  **Speed** graph for the last minute.
- **Transfers page** (was Queue): status tabs with counts, sort (added, name,
  progress, speed, ETA, size, ratio), multi-select with shift/⌘-click and
  bulk actions, right-click menu, keyboard shortcuts (↑/↓, Space, Enter,
  Delete, R, ⌘A), and a live engine footer (session ↓/↑, peers, DHT nodes,
  listen port, UPnP/uTP state).
- New engine settings: UPnP, DHT, local peer discovery, uTP, listen port, max
  peers per torrent, session-wide download/upload caps (live), seed ratio
  target and seed time limit. The proxy help text says exactly what a proxy
  covers for torrents (peer connections only).
- Double-clicking a `.torrent` while Prism is already running now works on
  Windows and Linux. Engine updated to librqbit 9.

Not possible with the current engine (so not faked): per-tracker status,
adding trackers to a running torrent, sequential download, per-peer progress
flags, moving a torrent's folder, and protocol encryption.

**Player.** mpv starts with config files, scripts and the youtube-dl hook
disabled, and the web view can only reach it through a small allowlisted
command set. Playback and HDR behaviour are unchanged. Fixed a latent memory
bug on the "player failed to start" path.

**Privacy & legal.** Opened files are marked as downloads so macOS/Windows apply
their usual checks; "Open" only hands media, subtitle, image and text files to
the OS. Crash reports (still off by default) now scrub URLs and paths, carry no
console breadcrumbs, and actually reach Sentry (they were blocked by the
content-security policy before). New setting to turn clipboard link detection
off. The Privacy Policy and Terms were rewritten to say what the app really does;
the credits page lists every bundled library, and license texts now ship inside
the app.

**Supply chain.** Every bundled binary (yt-dlp, Deno, libmpv, the wrapper) is
pinned by version and SHA-256 in `scripts/sidecars.lock` and verified at build
time; releases state exactly what they contain (below). CI now runs `cargo
audit` and `npm audit`, and type-checks the macOS and Windows code paths.

**Fixes carried over since 1.7.3:** Windows player DLL loading, outbound links
in the web view, release-build logging for player diagnostics.

## Install

- **macOS:** `brew install --cask rajatraina747/prism/prism`, or download the
  `.dmg`. Not notarized: on macOS 15+ open the app once, then System Settings →
  Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/Prism.app`).
- **Windows:** run the installer; click "More info → Run anyway" on the SmartScreen prompt.
- **Linux:** AppImage, `.deb` or `.rpm`.
