# Prism Roadmap

Goal: close the gap to flagship downloaders (Downie, 4KVD, JDownloader) using only
free tooling. Ordered by impact.

## Done — v1.0/v1.1 hardening arcs

### Trust layer (bugs where the UI lies)

- [x] **Real cancellation.** `cancelDownload` / `pauseDownload` / `removeFromQueue` /
  `pauseAll` in `AppProvider` must call `service.cancelDownload(id)` so the Rust side
  kills the yt-dlp child. Today only the event listeners are detached and the process
  keeps downloading.
- [x] **Sanitize titles.** Video titles flow raw into the yt-dlp output template
  (`${dest}/${filename}.%(ext)s`). Strip path separators, escape `%` → `%%`.
- [x] **Real pause/resume.** Pass `--continue` and reuse the same output path on
  resume so yt-dlp picks up `.part` files instead of restarting from zero.
- [x] **Harden path validation.** Use `Path::components()` (reject `ParentDir`)
  instead of `contains("..")`; canonicalize before the allowed-prefix check.

### Robustness (survive the real world)

- [x] **Self-updating yt-dlp.** Fetch latest yt-dlp release binary from GitHub into
  app-data; prefer it over the bundled sidecar. Decouples "YouTube broke" from
  "wait for a Prism release".
- [x] **Crash-safe queue.** Recover `.part` files on startup; offer to resume
  interrupted downloads.
- [x] **Auto-retry with backoff.** 2–3 retries before failing; pass `--retries` /
  `--fragment-retries` to yt-dlp.
- [x] **Actionable errors.** Map common yt-dlp stderr patterns ("Sign in to confirm",
  "Video unavailable", HTTP 429) to specific suggestions instead of the generic
  network bucket.
- [x] **Disk space preflight** when format size is known.

### Feature gap (flagship conveniences)

- [x] **Clipboard watcher.** On window focus, detect a video URL on the clipboard and
  offer one-click add.
- [x] **Metadata embedding.** `--embed-thumbnail --embed-metadata --embed-chapters`.
- [x] **Cookies-from-browser setting.** Settings dropdown → `--cookies-from-browser <browser>`.
- [x] **Deep-link scheme + bookmarklet.** `prism://add?url=...` via
  `tauri-plugin-deep-link`.

### Engineering maturity

- [x] **Integration tests against the real yt-dlp sidecar.**
- [x] **CI gates:** `cargo clippy -- -D warnings`, eslint, coverage floor,
  Playwright smoke test against the built app.

## Next arc — July 2026 (free tooling only)

### Tier 0 — Debt paydown (prerequisites for subscriptions)

- [x] **Verify engine updates against `SHA2-256SUMS`.** yt-dlp publishes a SHA-256
  manifest per release; check it before the atomic swap so a corrupted or
  tampered download can never become the engine.
- [x] **Fix audio dedupe.** `dedupe_output_path` only probed `.mp4`; audio-only
  downloads (`.mp3`) collided with existing files. Now probes all output extensions.
- [x] **Fix long-download ETA.** Progress regex only matched `MM:SS`; `H:MM:SS`
  ETAs displayed wildly wrong.
- [x] **Fix speed-limit truncation.** Limits under 1 MiB/s truncated toward zero
  (`{}K` after integer division); pass raw bytes/sec to `--limit-rate`.
- [x] **Debounce queue persistence.** Progress ticks were serializing the whole
  queue to disk several times per second.
- [x] **Queue state machine refactor.** All queue transitions now live in a pure,
  guarded reducer (`src/stores/queue-reducer.ts`, 16 unit tests covering the
  races); `AppProvider` only performs side effects and dispatches. Kept in TS
  rather than Rust so the mock service / web demo keep working. Prerequisite
  for subscriptions: they multiply concurrent queue mutations.

### Tier 1 — Flagship gap

- [x] **Subscriptions.** Watch a channel/playlist, auto-download new videos.
  Implemented as flat-playlist polling + seen-URL diffing (rather than
  `--download-archive`) so new videos flow through the normal queue with
  progress UI. Seen set is seeded at subscribe time — only videos published
  after subscribing are downloaded. Configurable check interval in Settings.
- [x] **Firefox extension.** `extension/firefox/` — MV3 event page, toolbar
  button + page/link context menus, hands off via `prism://add?url=...`.
  Passes `web-ext lint` (0 errors); publishing to AMO needs a free account
  (packaging instructions in the folder's README).
- [x] **Batch import.** Already existed: the Dashboard URL input accepts
  multi-line paste and queues every URL (`handleBatchSubmit`).
- [x] **SponsorBlock integration.** Settings → Downloads dropdown: off / mark
  as chapters (`--sponsorblock-mark all`) / remove segments
  (`--sponsorblock-remove sponsor,selfpromo,interaction`). Read by the Rust
  side from settings.json with a whitelist, same pattern as browser cookies;
  gated on ffmpeg since both are postprocessors.
- [x] **Scheduling / bandwidth windows.** "Quiet hours" (Settings → Queue):
  between a start/end hour (wraps overnight), new downloads are either held
  or started throttled to a configured speed. Applied at start time via the
  auto-start gate; pure logic in `src/stores/schedule.ts` with unit tests.

### Tier 2 — Trust & distribution (free versions)

- [ ] **Signed auto-updates via Tauri updater keys** (minisign — free, no Apple cert).
- [x] **Homebrew cask tap.** `rajatraina747/homebrew-prism` —
  `brew tap rajatraina747/prism && brew install --cask prism`. Passes
  `brew audit --online`; bump instructions in the tap README (manual until a
  cross-repo PAT is set up for auto-bump from build.yml).
- [ ] **winget manifest.** Needs a PR to microsoft/winget-pkgs; worth doing
  once there's a stable Windows user base.
- [x] **Crash reporting, opt-in.** Sentry free tier. Doubly gated: build must
  have `SENTRY_DSN` baked in (CI secret; missing = fully disabled) AND the
  user must flip Settings → Diagnostics → Crash reporting (off by default).
  Frontend errors via @sentry/react (no tracing/PII/sessions), Rust panics
  via the sentry crate (toggle applies at next launch).
- [x] **Windows + Linux release builds in CI.** Windows already existed;
  `build-linux` job added to build.yml (AppImage/deb/rpm + updater artifacts,
  x86_64, same sidecar strategy). First exercised at the v1.3.0 tag.

### Tier 3 — Daily-driver polish

- [ ] **Menu bar / tray quick-add** — paste a URL without the window open; pairs
  with the clipboard watcher.
- [ ] **Drag-and-drop** a URL onto the window or dock icon.
- [x] **History that works harder.** Search + status tabs already existed;
  added re-download (queues again with the original settings) and Play /
  Show-in-Folder actions on completed entries.
- [ ] **Richer format choices:** audio bitrate/codec options (m4a vs mp3), and a
  per-site "smart preset" that remembers last-used settings.

## Explicitly deferred

- Paid Apple notarization (ad-hoc signing + Homebrew cask for now).
- Multi-language UI, theming, mobile.
- Custom download engine — yt-dlp is the moat; Prism's value is the experience
  around it.
- Account/premium-host handling à la JDownloader — maintenance tarpit, outside
  Prism's identity.
