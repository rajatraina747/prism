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

## Explicitly deferred

- Paid Apple notarization (ad-hoc signing + Homebrew cask for now).
- Multi-language UI, theming, mobile.
- Custom download engine — yt-dlp is the moat; Prism's value is the experience
  around it.
- Account/premium-host handling à la JDownloader — maintenance tarpit, outside
  Prism's identity.
