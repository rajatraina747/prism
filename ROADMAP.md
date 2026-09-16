# Prism Roadmap

Goal: close the gap to flagship downloaders (Downie, 4KVD, JDownloader) using only
free tooling. Ordered by impact.

The v1.0/v1.1 hardening arcs and the July 2026 "free tooling" arc are shipped;
what remains open is below. Completed items live in git history.

## Open items

- [x] **Signed auto-updates via Tauri updater keys** (minisign pubkey in
  tauri.conf.json; releases carry `latest.json` signatures).
- [ ] **winget manifest.** Needs a PR to microsoft/winget-pkgs; worth doing
  once there's a stable Windows user base.
- [x] **Per-site smart preset** that remembers last-used settings per domain
  (`perSitePresets`, keyed via `siteKey`).

## Arcs from the September 2026 follow-up review

Full findings, verified against code and live data, in
[docs/REVIEW-2026-09-14.md](docs/REVIEW-2026-09-14.md). The v1.8.1 hotfix
(finished downloads not archived; flat multi-file torrents sharing one folder;
yt-dlp config/plugin lockdown; symlink-safe Open; light-mode tokens; drop-once;
settings debounce; README accuracy) is shipped, and so is v1.9.0 below.

### v1.9 — "Trust & polish" (shipped 1.9.0)

- [x] Updater works on networks that black-hole one GitHub CDN address: the
      check/install run in Rust (`updater.rs`) with a connect timeout (hyper
      splits it across addresses, so a dead one falls through) and a read
      timeout; Settings shows the real error. Existing installs still need
      one manual update to get it.
- [x] S-1/S-2: fs capability narrowed to top-level `$APPDATA/*.json`
      (+ `.json.tmp`), no `fs:default` (its recursive global scope merges into
      every fs command); a Rust test pins the capability shape. The managed
      yt-dlp's SHA-256 is recorded at install and re-checked (cached by
      size+mtime) before it's preferred over the sidecar.
- [x] Confirmation card for OS/deep-link-originated links (`magnet:`,
      `prism://add`, OS-opened `.torrent`) before any network action; tray
      paste and drops unchanged (S-6).
- [x] Vendored mpv plugin: error instead of bare-DLL-name fallback (and on a
      failed Windows libmpv pre-load); `player_init` prechecks
      `player_available` (S-7).
- [x] Semaphore on yt-dlp captures (6, waits ≤60 s) and downloads (16,
      refuses); stdout capped at 64 MB, stderr keeps a 256 KB tail, error
      lines clipped (S-8).
- [x] `build.yml`: read-only by default, `contents: write` only on the build
      jobs; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` wired; `docs/RELEASE-KEYS.md`
      (S-10). **Rajat:** re-encrypt the key and set the password secret
      (step 1 in that doc).
- [x] Linux deny-list entries (`bin`, `Desktop/*.desktop`; `.local/bin` was
      already covered by the dotfile rule); case-insensitive compare on
      mac/win (S-9).
- [x] Failure UX: shared classifier (`services/errors.ts`) with an action;
      failed rows show suggestion → engine's one-line error (full text on
      hover) → "Set browser cookies" / Retry; failure toast carries the same
      action; parse errors under the URL box classified the same way;
      Settings opens at `?section=`.
- [x] One Add surface: sidebar button + ⌘N/⌘L sheet on every page (links,
      magnets, "Open .torrent…", a list file); drops anywhere in the window
      incl. `.torrent` files (bytes → `import_torrent_file` → cached magnet).
- [x] Settings restructure: Video / BitTorrent / Speed & schedule / Network
      as vertical Radix tabs, engine options behind "Show advanced", all
      speed limits in MB/s, jargon help tooltips, old `?section=` aliases.
- [x] Quiet-hours banner (Dashboard, Transfers) and "Held for quiet hours ·
      until HH:00" on queued rows.
- [x] Accessibility pass: every Settings control labelled/described by its
      row; Transfers rows are listbox options with a roving tab stop; Radix
      tabs for Transfers/Library filters; picker rows are checkboxes;
      `prefers-reduced-motion`; reorder handle no longer also moves selection.
- [x] Library and torrent/playlist pickers windowed past a threshold
      (`VirtualList`, @tanstack/react-virtual); list rows drop
      `backdrop-filter` (`surface-row`).
- [x] TypeScript `strict`; `no-unused-vars` / `no-explicit-any` as errors;
      Playwright (22 tests) in CI; `log::` coverage in the Rust backend;
      "Use IPv4 only" setting; WebP logos (7.4 MB → 87 KB); 31 unused
      shadcn components + 18 Radix packages removed; README screenshots
      regenerated (`scripts/readme-screenshots.mjs`); `SECURITY.md` with
      private vulnerability reporting enabled, issue templates, About →
      "Report a bug".
- [x] Verification added: the real capability driven through Tauri's IPC/ACL
      (mock runtime) test; opt-in network test proving the updater's connect
      timeout falls through a black-holed address; rustls → 0.23.45
      (RUSTSEC-2026-0285, published the day before 1.9.0).

Carried over from the review: S-5 (pin Homebrew mpv) is still open. S-11
(`explorer /select,` concatenation) and S-12 (raw stderr in error strings) are
fixed on the `v2.0` branch.

### v1.9.1 — player hotfix

- [x] macOS: opening the in-app player could deadlock the whole app. mpv was
      called on the main thread while its video output was waiting on the
      main thread. All mpv calls now go through one worker thread with
      timeouts (`mpv_worker.rs`), and the plugin's close handler no longer
      blocks main.
- [x] Guards: `clippy.toml` bans `run_on_main_thread` outside the AppKit-only
      sites; a unit test checks nothing but the worker reaches mpv.
- [x] Verification: `examples/mpv_thread_repro.rs` reproduces the old deadlock
      and checks the new call pattern. `scripts/verify-player-macos.sh` checks
      a real app bundle end to end. Postmortem addendum in
      [docs/AUDIT-2026-07.md](docs/AUDIT-2026-07.md).

### v1.9.2 — Vulkan driver hotfix

- [x] macOS: the player's video output runs on Vulkan, and macOS has no
      Vulkan driver. Releases since 1.7.1 bundled the Vulkan loader but not
      MoltenVK, so video only worked where Homebrew's molten-vk was installed
      (the development Mac included). The bundle now ships
      `libMoltenVK.dylib` with a manifest, and the app points the loader at it
      at startup. Proven with the thread harness and mpv's log: with the
      loader pointed at a missing driver the video output fails to start; with
      the bundled manifest alone it plays.

### v2.0 — "Download manager" (in progress on `v2.0`)

Decided 2026-09-15: the bundle id becomes `com.rainacorp.prism`; a basic
HTTP(S) engine is in; the extension goes to Edge Add-ons and AMO, with Chrome
as an unpacked zip; the privacy policy is hosted on rainacorp.co.uk.

**Foundations**
- [x] Identifier migration (`migrate.rs`): copy-only, staged, locked, marked.
      The allowed-dirs file is renamed and still read under the old name. The
      NSIS publisher is pinned to "prism" so Windows upgrades stay in place.
- [x] Structured errors (`errors.rs`, S-12): a code plus a redacted summary
      and detail from Rust; the UI classifies by code.
- [x] One process group per yt-dlp run (`spawn.rs`); shell plugin removed;
      the engine update's version check is bounded.
- [x] S-11 Explorer quoting; settings.json parsed once per change; tags with
      `-` build as prereleases; the first-run splash survives the rename.
- [x] Settings record the shape they were written in
      (`stores/settings-migrations.ts`) and are migrated before they merge
      over the defaults, so a later rename can't read as the user unsetting
      something. Settings written by a newer Prism are left exactly as they
      are rather than stamped back down to this version.
- [x] Windows: every run goes in a Job Object, so one call reaches whatever it
      forked and a download can't outlive Prism however Prism ends. `taskkill
      /T` stays as the fallback for the sliver between starting a process and
      assigning it.

**Engines and media**
- [x] LGPL media toolchain, on all three platforms — **closes S-5**. macOS
      builds libmpv, ffmpeg and ffprobe from pinned sources
      (`build-media-macos.sh`), the workflow publishes them on a dated release,
      and `sidecars.lock` pins it by URL and SHA-256, so a build unpacks that
      instead of installing Homebrew's mpv. Windows and Linux take BtbN's LGPL
      ffmpeg, pinned to a dated autobuild tag on the same branch macOS builds.
      All of it lands in `resources/lib/bin` rather than as Tauri sidecars,
      because `externalBin` is shared across platforms and naming it there
      would demand a sidecar on every one.
      CI fetches all three on every push and *starts* the binaries — which is
      what proves a shared build's libraries travelled with it — then reads the
      licence off them, because the release workflow only runs on tags and
      would otherwise be the first thing ever to exercise any of this.
      Intel Macs still fall back to Homebrew for local builds and are not
      released.
- [x] Engine freshness check: daily, an unobtrusive nudge, and a newer bundled
      engine beats an older self-updated one.
- [x] HTTP(S) direct-link engine (`http_engine.rs`): up to 4 connections,
      resume across pause and relaunch, optional SHA-256, quiet-hours cap.
      Disk images, archives, installers and documents route to it.
- [x] "Download as a file" when yt-dlp says a link is unsupported (probes
      first; web pages are refused).
- [x] Direct links: an expected SHA-256 goes on a queued download from the
      details panel (`stores/checksum.ts`), taken however it was published —
      upper case, a `sha256:` prefix, a whole line of `shasum` output — and
      refused rather than stored if it isn't one, since a mistyped hash that
      is never checked is worse than no hash. Only before it starts: the
      engine is handed the hash when it opens the file.
- [x] Stream while downloading ("Play now") — see the torrent arc below.

**Organising**
- [x] Filename templates (`template.rs`): rendered in Rust, previewed in
      Settings, recorded per item so a resume keeps its name.
- [x] Move finished downloads to another folder (`postprocess.rs`): before
      completion is reported, across devices by copy-then-remove, torrents
      once seeding ends, never overwriting.
- [x] Categories (`stores/categories.ts`): rules on site and engine, each with
      its own destination and file name template, applied when an item is
      queued and shown as a chip on its row.
- [x] Categories by hand: a picker in the details dialog — re-filing something
      that has already started changes its label only, never where it is
      writing — and a category filter on Transfers and Library.
- [x] Labels (several per item, unlike a category): defined in Settings, put on
      by hand from the details dialog, shown on the row, and a filter of their
      own on Transfers and Library. Ids are stored, not names, so renaming a
      label renames it everywhere.
- [x] Watch folders (`watch.rs`): `.torrent` files and text files of links,
      polled every few seconds, fed into the ordinary add flow as an in-app
      add. Handled files are renamed (`.added`/`.failed`), never deleted.

**Player**
- [x] Resume position (`player_state.rs`): where you stopped is kept per file —
      and per file of a torrent, so it survives the move from streaming to
      playing off disk — offered on reopen with "Start over", and forgotten
      once you have watched something to the end. The window reports only the
      number; which item it belongs to is Rust's to know.
- [x] Chapters (marks on the seek bar, previous/next, the current one named),
      external subtitles (sidecars found next to the file, or any file through
      the picker, plus a timing nudge), track menus, and a mini player. The
      mini player resizes and pins the window from Rust, so the player
      window's own permissions stay as narrow as they were.

**Library and automation**
- [x] Library multi-select and bulk actions: click, shift-click and meta-click
      reusing the same `nextSelection` Transfers uses, rather than a second
      selection model. Download again, show in folder, and remove — records
      only, with an undo that genuinely restores them, since removing from the
      Library never touched the files. Rows are options of a multi-select
      listbox now, so the selection is announced rather than only drawn.
- [ ] Library list model, grid view, density modes, storage tile.
- [ ] Bulk "move to Trash" — needs the `trash` crate and would be the first
      thing in Prism that deletes a finished download, which the Clear dialog
      currently promises it won't. Worth deciding rather than assuming.
- [ ] Undo that resumes (cancel-undo keeping partials).
- [x] Sleep, shut down or quit once the queue finishes
      (`stores/completion.ts`). It fires on the change from working to
      finished, never on a standing start — otherwise switching it on with an
      empty queue would sleep the machine on the spot. Seeding counts as work
      unless explicitly waived, so nothing sleeps mid-upload; paused does not,
      since a paused download never finishes on its own. A minute's countdown
      you can call off, and the action itself is a fixed per-platform command
      built in Rust — the string from the UI never reaches a shell.
- [x] Subscription rules: include/exclude keywords matched against a feed
      entry's title and link, and a category a whole feed is filed under. A
      video the rules turn down is still recorded as seen — otherwise every
      poll would reconsider it, and loosening a rule later would pull in the
      whole back catalogue at once.
- [x] Post-completion actions: notify, open, or show in folder — set once as a
      default, or on a single download in its details. An item saying nothing
      follows the default, which leaves "do nothing" free to mean a deliberate
      no for that one download rather than an absence. A torrent can finish
      without a file path, so open and reveal fall back to its folder instead
      of failing.
- [ ] Scheduling, duplicate detection, native menu, global shortcuts, Dock and
      taskbar progress.
- [ ] Undecided, not skipped: the plan's separate `rss_fetch` (reqwest +
      `feed-rs`). `parsePlaylist` already reads RSS and Atom through yt-dlp,
      so a second fetch path would add a dependency to do what works today —
      worth a decision rather than quietly adding it.
- [x] Statistics page (`stores/stats.ts`): counters kept as their own record,
      not a view of the Library, which is capped at 2,000 rows and forgets —
      seeded once from whatever history exists and updated where terminal
      items are archived, the one place every finished download passes through
      while its engine and uploaded bytes are still known. Upload is shown as
      a since-this-version figure rather than a lifetime one, because nothing
      in history records it. Charts are hand-drawn SVG, as the player's speed
      graph already is; no charting dependency.
- [ ] Clip download, chapter split, conversion presets, settings/Library
      export, qBittorrent and Transmission import.

**Distribution**
- [ ] Chrome/Edge and Firefox extension builds; hosted privacy page; winget;
      cask cleanup for both identifiers.
- [ ] Upstream librqbit PRs (tracked here, never blocking a release).

## Candidate arc — Second engine: BitTorrent (needs a go/no-go)

Prism today is a client-server pull (yt-dlp over HTTP). BitTorrent is a different
axis: a long-lived, bidirectional swarm participant that listens on a port, runs a
DHT node, verifies pieces by hash, and uploads as much as it downloads. This would
roughly double Prism's surface area — a second engine with its own settings, UI, and
lifecycle — so it is gated on a product decision, not just engineering.

**Positioning caveat (decide before building):** BitTorrent is a neutral, legal
technology (Linux ISOs, game patches, dataset distribution) but is more strongly
associated with piracy than yt-dlp. That affects app-store acceptance, hosting, and
how Prism is perceived. This is a deliberate identity shift from "video downloader"
to "download manager" — not a side feature. Does not contradict the deferred
"custom download engine" note below: we still wrap a library, we don't build
extraction.

### Approach

- **Engine: embed `librqbit` (pure-Rust) in `src-tauri`**, not a bundled binary.
  Slots in as a Cargo dependency — no second sidecar to bundle, checksum, and
  self-update the way `engine.rs` manages yt-dlp. (Alternative considered:
  `aria2c`/`transmission-daemon` as a Tauri `externalBin` driven over RPC, which
  mirrors the yt-dlp sidecar pattern but adds binary-management overhead. Rejected
  unless `librqbit` proves insufficient.)

### Phased

- [x] **Spike — GO.** `librqbit` 8.x embeds cleanly in `src-tauri` (`torrent.rs` +
  `examples/torrent_spike.rs`): builds against the Tauri dep tree, passes
  `clippy -D warnings`, and downloaded the Debian 13.5 netinst torrent to
  completion with per-second progress — final ISO SHA-256 matched Debian's
  published checksum. `AddTorrent::from_url` handles both magnets and `.torrent`
  HTTP URLs. No conflict with the Tauri async runtime.
- [x] **Queue integration.** `TorrentManager` (`src-tauri/src/torrent.rs`) mirrors
  `DownloadManager`: one librqbit session, a handle map, a poll loop emitting the
  same `download-progress-{id}` / `download-complete-{id}` events. A `kind`
  discriminant + optional swarm fields (peers/seeds/uploadSpeed/ratio) and a new
  `seeding` status were added to the model; the reducer drives downloading→seeding
  and completes from either (6 new reducer tests). `start_torrent`/`cancel_torrent`
  commands; the frontend service branches on `kind`, cancel signals both engines.
- [x] **Progress model.** Extended the existing queue item rather than forking a
  parallel one — QueueTable renders peers while downloading and a Seeding row
  (↑ speed / peers / ratio) with a stop-seeding control.
- [x] **Input paths.** `magnet:` and http(s) `.torrent` URLs detected at the add
  boundary (`isTorrentUrl`) and routed straight to the torrent engine, skipping
  yt-dlp; wired into single add + batch paste. (Deep-link/clipboard/tray still
  filter to http(s) — magnets go through the URL box for now.)
- [x] **Seeding policy + UI.** User setting (Settings → Downloads): stop at 100% /
  seed to ratio 1.0 (default) / seed until stopped. Read Rust-side from
  settings.json (whitelisted), like audioFormat.
- [x] **Networking.** Session created with `enable_upnp_port_forwarding` + a
  stable listen-port range (4240–4260) + fastresume, so NAT'd users get inbound
  peers and restarts resume.
- [x] **Openable paths.** Completion resolves `<output_dir>/<torrent name>` —
  the file for single-file torrents (Play works), the top-level folder for
  multi-file (Show-in-Folder reveals it; `validate_open_path` now allows dirs for
  reveal). Play is hidden for torrents in the Downloads list.
- [x] **Upload throttling in Quiet Hours.** `set_torrent_rate_limit` command
  drives librqbit's live session rate limits (download + upload, so it caps
  seeding); an AppProvider effect pushes the `scheduleGate` limit whenever the
  window flips.
- [x] **Multi-file breakdown.** Per-file names + sizes + progress emitted in the
  torrent progress event and shown as an expandable "N files" list in the queue
  row.
- [x] **Per-file select (deselection).** `parse_torrent` lists files via a
  list-only add (resolves magnet metadata from peers) → `TorrentFilesModal`
  checkbox picker (sizes, select-all, running total) → chosen indices flow through
  as `AddTorrentOptions.only_files`. All files selected by default.
- [x] **OS magnet/.torrent handling.** Registered the `magnet:` scheme + a
  `.torrent` file association (tauri.conf.json); the deep-link/tray handlers route
  magnets and .torrent files into the add flow. NOTE: the OS still won't make
  Prism the *default* magnet handler automatically — the user picks it (µTorrent
  etc. hold the default until changed). Takes effect after install of a build
  carrying this config.
- [ ] **Sparse/preallocated file control.** librqbit defaults are fine; expose
  only if users need it.

## Arc — Classic client parity (July 2026)

Features uTorrent/Vuze users expect, gated on what librqbit 8.x actually
exposes. Shipped in one pass:

- [x] **Native pause/resume.** `session.pause()/unpause()` through new
  `pause_torrent`/`resume_torrent` commands; the poll loop survives a pause
  (skips emits via `handle.is_paused()`). Resume no longer re-adds + re-hash-
  checks; the delete/re-add path remains as fallback (and after app restart).
  AppProvider branches per engine in pause/resume/pauseAll/startAll.
- [x] **Extra trackers.** `extraTrackers` setting (Settings → Downloads) →
  `AddTorrentOptions.trackers` on every add. Filtered Rust-side to
  http(s)/udp.
- [x] **Per-torrent speed limit.** `settings.speedLimit` now flows to torrents
  (`AddTorrentOptions.ratelimits.download_bps`), on top of the session-wide
  Quiet-Hours limit.
- [x] **Editable file selection mid-download.** Checkboxes in the queue row's
  file list → `update_torrent_files` → `session.update_only_files`; selection
  persisted back into `settings.selectedFiles` so restarts keep the subset.
- [x] **IP blocklist.** `blocklistUrl` setting → `SessionOptions.blocklist_url`
  (standard p2p formats). Session-creation option: applies on next launch.
- [x] **Copy magnet/source link** action on every queue row.
- [x] **Swarm health readout.** peers_seen/peers_connecting from librqbit's
  aggregate stats; the row distinguishes "searching for peers", "connecting",
  "0 of N reachable" (NAT hint) and "N peers · M seen".
- [x] **Per-IP peer table.** librqbit 9: `TorrentStateLive::per_peer_stats_snapshot`
  (filter built via serde so the un-exported type needn't be named); speeds
  differenced Rust-side; Peers tab in the detail panel. Engine still reports no
  per-peer progress/flags.
- [x] **Manual "update tracker" / force reannounce.** `Session::pause` +
  `unpause` keeps piece state and issues a fresh tracker/DHT/LSD announce —
  wired as "Update tracker" (row/context menu/`R`) and run automatically every
  5 min while a torrent is peerless. Peerless torrents never fail on their own
  (optional `torrentGiveUpMinutes`).
- [x] **Session persistence + fastresume** (app_data/torrent-session): relaunch
  spot-checks pieces instead of re-hashing; `add_or_adopt` reuses restored
  handles. **Force re-check** (delete + re-add) and **Remove and delete files**.
- [x] **Transfers page**: status tabs, sort, multi-select, context menu,
  shortcuts, detail panel (General/Files/Peers/Trackers/Speed, pieces map),
  engine footer; settings for uTP/LSD/port/peer limit/caps/seed ratio & time.
- [ ] **Engine-blocked (librqbit 9 has no API):** per-tracker status, adding
  trackers to a running torrent, sequential download / piece priorities,
  availability, moving a torrent's folder, per-torrent limits after add,
  protocol encryption. Upstream PR territory; the UI says so rather than faking it.
- [x] **Stream-while-downloading.** librqbit's `FileStream` (AsyncRead+AsyncSeek,
  on-demand piece prioritization) served over a loopback HTTP server
  (`stream_server.rs`): axum on 127.0.0.1 with a port the OS picks, one route
  per (torrent, file), a token minted per launch and compared in constant time,
  a `Host` check, no CORS header, and a single Range per request. "Play now"
  appears in the details Files tab for a file the torrent is already fetching —
  selecting one there would mean calling librqbit's all-or-nothing
  `update_only_files` and silently dropping every other file the user chose.
  The CSP question turned out to be moot: mpv fetches the URL itself, so the
  webview never loads it.
- [ ] **Watch folder.** Poll a user-chosen dir for new `.torrent` files →
  add flow. Cheap via `notify` crate or a 10s scan; needs dedupe against
  already-added infohashes.
- [ ] **Move completed to folder.** Post-completion rename into a "done" dir;
  interacts with seeding (librqbit holds file handles while seeding — move on
  seed-complete, not download-complete).

## Arc — In-app player (decided July 2026)

Play downloaded files inside Prism — no Finder/Explorer round-trip, no external
player. Requirement set is full-fat playback: arbitrary codecs/containers
(H.264/HEVC/VP9/AV1, mkv/webm — torrent content especially), HDR and SDR,
multichannel audio (5.1/7.1/stereo), subtitle tracks.

**Engine decision: libmpv.** The requirements rule out the webview `<video>`
tag (codec coverage varies per-platform webview; no HDR passthrough; flaky
multichannel). libVLC was evaluated and rejected: no supported way to composite
a native surface inside a Tauri webview (tauri discussions #6343/#7895),
40–80 MB per platform, LGPL dynamic-linking overhead for less-maintained
bindings. libmpv has a maintained integration path (`tauri-plugin-libmpv`,
renders into the window via wid/render API), hardware decode, HDR
tone-mapping/passthrough, and proper audio channel layouts. VLC's source
(github.com/videolan/vlc) stays a UX/architecture reference only.

Phased:

- [x] **Spike — GO (July 2026), with a macOS caveat worth recording.** mpv's
  `--wid` embedding is broken on macOS: instead of a subview, libmpv 0.41
  creates its own borderless NSWindow. Solved by *adopting* that window as a
  child of the player window ordered below it (`src-tauri/src/player.rs`):
  frame pinned on resize, level + z-order re-asserted (simple fullscreen
  changes window level), `ignoresMouseEvents` on the video window, and a 1%-
  alpha webview surface so macOS never routes clicks through to it. Native
  fullscreen (Spaces) is stripped from the player window — child windows
  can't follow into a Space (stranded black desktop); ⤢ uses *simple*
  fullscreen instead. **Acceptance criteria (non-negotiable, verify on
  content that really has them): (a) true HDR output on an HDR display
  (`target-colorspace-hint` is set; verify brightness pops vs an SDR player);
  (b) 5.1 plays with correct layout (badge + track picker show channels);
  (c) subtitle/audio track switching works.** Note: YouTube "4K HDR" titles
  downloaded as H.264 are 1080p SDR stereo — test with HDR10 mkvs.
- [x] **Phase 1 — Play completed files in-app (dev builds).** "Play in Prism"
  on Library rows + per-torrent-file, separate transparent `player` window
  (`src/pages/Player.tsx`; the player window must never mount AppProvider —
  it would double-run the download orchestrator). Chrome: seek, volume,
  speed, subtitle/audio pickers, HDR/resolution/channel badges, keyboard,
  Open file…, simple fullscreen. Gated behind `player_available` (the libmpv
  wrapper staged next to the exe — build.rs does this for dev) so release
  builds hide the buttons until Distribution ships.
- [x] **Phase 2 — converged with stream-while-downloading.** The loopback
  FileStream server (above) feeds the same player through `player_load_stream`:
  "Play now" on a downloading torrent. mpv handles growing files / Range
  streams natively.
- [x] **Distribution (v1.7.1).** macOS: `scripts/bundle-libmpv-macos.sh`
  collects brew libmpv + full dep tree via dylibbundler (all references
  rewritten to @loader_path, verified no /opt/homebrew remains, ~61 MB) into
  resources/lib; the vendored plugin (`src-tauri/vendor/tauri-plugin-libmpv`,
  MPL-2.0, patched to search the resource dir) loads it from there. Windows:
  wrapper DLL + zhongfly's self-contained LGPL libmpv-2.dll under resources
  lib/ (= exe-adjacent on Windows). Linux: still gated off via
  `player_available` — upstream embedding doesn't work there yet. Licenses
  page lists mpv (GPL2+ mac build / LGPL win build), wrapper (LGPL-2.1),
  plugin (MPL-2.0).

## Hardening & performance backlog

July 2026 audit ([docs/AUDIT-2026-07.md](docs/AUDIT-2026-07.md)) and the
September 2026 third-party review ([docs/AUDIT-2026-09.md](docs/AUDIT-2026-09.md)).
Everything below the line shipped in **v1.8.0**; what's left is open.

- [x] `cargo update` cleared quick-xml/h2/rkyv advisories (librqbit → 9.x);
  `cargo audit` + `npm audit` are CI gates.
- [x] Deny-list for sensitive home subtrees (`~/Library`, `AppData`, dotfiles)
  + user-picked roots for external drives (`pick_download_dir`).
- [x] https-only `blocklistUrl`; timeouts + size caps on `update_ytdlp`.
- [x] `-N 4` fragment concurrency; progress emits throttled to 4/s; history
  writes debounced; Sentry dynamically imported.
- [x] "Keep original container" setting.
- [x] Sidecars pinned + SHA-256-verified (`scripts/sidecars.lock`); actions
  pinned to SHAs; macOS/Windows cargo check in CI.
- [x] Player: mpv lockdown + Prism-owned allowlisting commands; plugin UB fix.
- [x] Quarantine flag on downloads; media-only `open_file`.
- [x] Legal pages, credits and bundled license texts.
- [x] **LGPL-only mpv/FFmpeg build for macOS** so the macOS bundle stops
  carrying GPL x264/x265/rubberband (the player only decodes; nothing is
  lost). Built from pinned sources by `scripts/build-media-macos.sh`,
  published on a dated release, pinned in `sidecars.lock` and unpacked by
  `fetch-sidecars.sh` — so from the next macOS build the bundle carries the
  LGPL libmpv, ffmpeg and ffprobe, and the written offer is the
  corresponding-source tarball published beside them. Not yet released, and
  Intel Macs still use Homebrew locally.
- [x] Virtualize the Library (1.9.0; the 2,000-row history cap stays).
- [ ] Spawn yt-dlp in its own process group (`tokio::process` +
  `process_group`) instead of the `ps`-snapshot tree kill.
- [x] Run the Playwright suite in CI against the web demo (1.9.0).

## Explicitly deferred

- Paid Apple notarization (ad-hoc signing + Homebrew cask for now).
- Multi-language UI, theming, mobile.
- Custom download engine — yt-dlp is the moat; Prism's value is the experience
  around it.
- Account/premium-host handling à la JDownloader — maintenance tarpit, outside
  Prism's identity.
