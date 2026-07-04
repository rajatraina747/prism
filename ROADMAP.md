# Prism Roadmap

Goal: close the gap to flagship downloaders (Downie, 4KVD, JDownloader) using only
free tooling. Ordered by impact.

The v1.0/v1.1 hardening arcs and the July 2026 "free tooling" arc are shipped;
what remains open is below. Completed items live in git history.

## Open items

- [ ] **Signed auto-updates via Tauri updater keys** (minisign — free, no Apple cert).
- [ ] **winget manifest.** Needs a PR to microsoft/winget-pkgs; worth doing
  once there's a stable Windows user base.
- [ ] **Per-site smart preset** that remembers last-used settings per domain.

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

- [ ] **Spike.** Add `librqbit` to the Rust backend; get a single magnet link
  downloading to disk with progress logged to console. No UI. Go/no-go gate on
  the whole arc — validates integration effort before committing.
- [ ] **Networking.** Inbound listen port + UPnP/NAT-PMP port mapping for peer
  connectivity; graceful fallback when mapping fails.
- [ ] **Progress model.** Torrents carry peers, seeds/leechers, ratio, up/down
  speed — richer than yt-dlp's linear progress. Likely a new queue item variant
  rather than overloading the existing one (respect the reducer contract in
  `src/stores/queue-reducer.ts`).
- [ ] **Input paths.** `.torrent` file open + `magnet:` link handling, wired into
  the existing add flows (clipboard watcher, deep link, drag-and-drop).
- [ ] **Storage.** Multi-file torrents, sparse/preallocated files, per-file
  select.
- [ ] **Seeding policy + UI.** Seed-ratio limits, pause-on-complete, stop-seeding
  controls. Reuse Quiet Hours (`src/stores/schedule.ts`) for upload throttling.

## Explicitly deferred

- Paid Apple notarization (ad-hoc signing + Homebrew cask for now).
- Multi-language UI, theming, mobile.
- Custom download engine — yt-dlp is the moat; Prism's value is the experience
  around it.
- Account/premium-host handling à la JDownloader — maintenance tarpit, outside
  Prism's identity.
