# Prism Roadmap

Goal: close the gap to flagship downloaders (Downie, 4KVD, JDownloader) using only
free tooling. Ordered by impact. Tiers: 1 = honest, 2 = dependable, 3 = lovable,
4 = sustainable.

## Tier 1 — Trust layer (bugs where the UI lies)

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

## Tier 2 — Robustness (survive the real world)

- [x] **Self-updating yt-dlp.** Fetch latest yt-dlp release binary from GitHub into
  app-data; prefer it over the bundled sidecar. Decouples "YouTube broke" from
  "wait for a Prism release". Highest-leverage feature in this tier.
- [x] **Crash-safe queue.** Recover `.part` files on startup; offer to resume
  interrupted downloads.
- [x] **Auto-retry with backoff.** 2–3 retries before failing; pass `--retries` /
  `--fragment-retries` to yt-dlp.
- [x] **Actionable errors.** Map common yt-dlp stderr patterns ("Sign in to confirm",
  "Video unavailable", HTTP 429) to specific suggestions instead of the generic
  network bucket.
- [x] **Disk space preflight** when format size is known.

## Tier 3 — Feature gap (flagship conveniences)

- [x] **Clipboard watcher.** On window focus, detect a video URL on the clipboard and
  offer one-click add.
- [x] **Metadata embedding.** `--embed-thumbnail --embed-metadata --embed-chapters`.
- [x] **Cookies-from-browser setting.** Generalize the Safari-cookie trick:
  Settings dropdown → `--cookies-from-browser <browser>`.
- [x] **Deep-link scheme + bookmarklet.** `prism://add?url=...` via
  `tauri-plugin-deep-link`; later a Firefox extension (free to publish).
- [ ] **Subscriptions.** Watch a channel/playlist, auto-download new videos
  (`--download-archive` + `--dateafter`).
- [ ] **Scheduling / bandwidth windows.** Time-of-day rules on top of existing
  speed limits.

## Tier 4 — Engineering maturity

- [x] **Integration tests against the real yt-dlp sidecar** (the seam where both
  Tier-1 bugs lived; unit tests can't catch this class).
- [x] **CI gates:** `cargo clippy -- -D warnings`, eslint, coverage floor,
  Playwright smoke test against the built app.
- [ ] **Crash reporting** (Sentry free tier or self-hosted GlitchTip), opt-in.
- [ ] **Free distribution:** Homebrew cask tap, winget manifest.

## Explicitly deferred

- Paid Apple notarization (ad-hoc signing works for now).
- Multi-language UI, theming, mobile.
- Custom download engine — yt-dlp is the moat; Prism's value is the experience
  around it.
