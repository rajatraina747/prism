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
- [ ] **Per-IP peer table.** BLOCKED upstream: librqbit 8.1.1 doesn't re-export
  `PeerStatsFilter`/`PeerStatsSnapshot`, so `api_peer_stats` is uncallable from
  outside the crate. Needs an upstream PR (or the http-api feature + local
  port). Aggregate counts above cover the main diagnostic need meanwhile.
- [ ] **Manual "update tracker" / force reannounce.** Not exposed by librqbit
  8.x at all; `force_tracker_interval` at add time is the only knob. Upstream
  PR territory.
- [ ] **Stream-while-downloading (flagship candidate).** librqbit's
  `FileStream` (AsyncRead+AsyncSeek, on-demand piece prioritization) served
  over a localhost HTTP server (Range support) → "Play now" on a downloading
  torrent. Design sketch: axum/hyper listener on 127.0.0.1:<random>, one route
  per (torrent, file); Play button switches label while status=downloading;
  CSP already allows localhost? verify `connect-src`/media loading. Biggest
  remaining UI+backend lift; do as its own arc.
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
- [ ] **Phase 2 — converge with stream-while-downloading.** The localhost
  FileStream server (above) feeds the same player: "Play now" on a downloading
  torrent. mpv handles growing files / Range streams natively.
- [ ] **Distribution.** Bundle libmpv per platform (mac: dylib; win:
  mpv-2.dll; linux: system libmpv for deb/rpm, bundled for AppImage).
  License audit: libmpv LGPLv2.1 → dynamic link, ship license text in the
  OpenSourceLicenses page.

## Hardening & performance backlog (July 2026 audit)

Full findings with file references in [docs/AUDIT-2026-07.md](docs/AUDIT-2026-07.md).
Headlines:

- [ ] `cargo update` to clear quick-xml RUSTSEC-2026-0194/0195 (DoS, CVSS 7.5)
  once the Tauri/librqbit trees allow ≥0.41.
- [ ] Exclude `~/Library` (and Windows autorun dirs) from allowed download
  roots — torrent file names are untrusted metadata.
- [ ] Require https for `blocklistUrl`; add an HTTP timeout to `update_ytdlp`.
- [ ] Pass `-N 4` (concurrent fragment downloads) to yt-dlp — the single
  biggest throughput win vs 4KVD/IDM-class tools.
- [ ] Offer "keep original container" alongside forced-MP4 remux (VP9/AV1 in
  mp4 confuses some players).
- [ ] Throttle progress emits Rust-side (~4/s per item); virtualize/paginate
  Library once history grows; debounce history writes; dynamic-import Sentry.

## Explicitly deferred

- Paid Apple notarization (ad-hoc signing + Homebrew cask for now).
- Multi-language UI, theming, mobile.
- Custom download engine — yt-dlp is the moat; Prism's value is the experience
  around it.
- Account/premium-host handling à la JDownloader — maintenance tarpit, outside
  Prism's identity.
