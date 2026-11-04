# Prism — roadmap and project notes

The one working document for Prism: where things stand, what's next, how to
release, and the rules the code follows. `README.md` is the public page and
`RELEASE_NOTES.md` is the next release's notes (the release workflow reads it
verbatim). Everything else lives here.

Older reviews, audits and test plans (July–November 2026) were folded in on
2026-11-05. Their text is still in git; see [History](#history). Code comments
such as `REVIEW 2026-09-26 M4` refer to findings in those reviews.

---

## Status

- **Released:** v2.3.6 (2026-11-05). Convert's H.264/HEVC presets work with the
  LGPL ffmpeg: encoders are picked in `src-tauri/src/encoders.rs`.
- **In review:** PR #28, `feature/play-any-file`. Play any audio or video file:
  Library button, ⌘O, drag onto the player, subtitles from anywhere. Tests pass,
  but it hasn't been GUI-checked yet.
- **Next release:** 2.4.0 = PR #28 + the "Before 2.4.0" list below.

Last full review: 2026-11-05. No High or Critical security findings. The design
held up where tested: Rust owns every trust decision, the page is untrusted,
each window has its own capabilities, and mpv is locked down. Verified against
the shipped libmpv: a `.mkv` that is really an HLS or M3U playlist fetches
nothing.

---

## Next up

### Before 2.4.0

- [x] **Mirror the Windows/Linux media builds.** `fetch-sidecars.sh` tries
  `rajatraina747/prism` release `$MEDIA_THIRDPARTY_TAG` first, then upstream,
  with the same SHA-256. `media-thirdparty-20261101` holds the current pins
  (verified 2026-11-05: the fetch works with upstream unreachable, and Latest
  is untouched). **After every `update-sidecars.sh` repin, run
  `scripts/mirror-media.sh`.**
- [x] **Limit the Apple-playback re-encode to macOS by default.** New setting
  `applePlayable` ("Make videos play on Apple devices"). When unset, it's on for
  macOS and off elsewhere (`lib.rs apple_playable`). The re-encode is also
  skipped above 1080p when only OpenH264 is available, and when there isn't room
  for a second copy. It now reports progress.
- [ ] **Gate ⌘O on `player_available`.** PR #28: on a build without libmpv,
  show a toast instead of opening a player window that fails.
- [ ] **README pass.** The feature list is missing Convert, direct-link
  downloads, RSS feeds and play-any-file. It mentions only the Firefox extension,
  but a Chromium build ships too.

### Hygiene (2.4.x)

- [ ] **Filtering DNS resolver for URLs a remote server chooses** (Low–Med). A
  redirect or DNS answer can still point direct downloads, RSS fetches or
  thumbnails into the LAN or loopback. Where:
  `http_engine.rs build_client`, `rss.rs client_for`, `thumbnails.rs`.
  - Add a `reqwest::dns::Resolve` that drops non-public IPs (`is_public_ip`).
  - Links the user pasted with a LAN address (a NAS) keep the plain client.
  - Behind a proxy, keep the literal-IP check.
- [ ] **Dev server on loopback only.** `vite.config.ts`: change `host: "::"`
  to `"127.0.0.1"`. Update vite/esbuild: esbuild ≤0.24.2 lets websites read the
  dev server. Release builds aren't affected.
- [ ] **CI on Node 22 or 24.** Every `node-version: 20` line in ci, build and
  deploy-web.
- [ ] **No Rust cache in signed release jobs.** Remove `Swatinem/rust-cache`
  from the `environment: release` jobs in `build.yml`.
- [ ] **Clear the cargo-audit ignores.** In `src-tauri/.cargo/audit.toml`:
  - Raise `rust-version` from 1.80 to 1.90.
  - Update `tauri-plugin-updater` from 2.11 to 2.14 or later, then drop the zip-4
    ignores (RUSTSEC-2026-0367 to -0369).
  - Drop crypto-bigint (RUSTSEC-2026-0387) when `pgp` moves to 0.7.
  - Leave ringbuf (RUSTSEC-2026-0293) until librqbit-utp updates.
  - Status 2026-11-05: 0 vulnerabilities, 14 allowed warnings. npm: 0 in
    production; 6 dev-only.
- [ ] **Drop next-themes.** It triggers a script-tag warning under React 19
  (`App.tsx`, `ui/sonner.tsx`, `use-theme-sync.ts`). Set the theme class in
  `main.tsx` before first render.
- [ ] **Library "Clear" calls `removeFromHistory` once per row.** Add a
  `removeManyFromHistory(ids)` (`Library.tsx` ~188).
- [ ] **Synchronous `std::fs` in async paths.** In `http_engine.rs`
  (`choose_destination`, `still_needed`, `saved_segments`).
- [ ] **Free-space check before a torrent.** In `start_torrent`/`parse_torrent`:
  compare the selected size with `fs2::available_space` and return the free
  space to the file picker.
- [ ] **A way to forget playback positions.** `player-state.json` stores file
  names (titles), now for any local file you play. Add a Settings button to
  clear it.
- [ ] Vite 7 and Tailwind 4, one commit each (still on Vite 5 / Tailwind 3).

### Player, round 2 (2.5)

- [ ] **Folder and playlist playback, next and previous.** Pick several files
  or a folder and queue them with mpv's `append`; never hand mpv a directory.
  Validate the folder and collect media with `is_openable_media`, naturally
  sorted and capped. Add Next/Prev and N/P keys, and auto-advance to the next
  episode. This also brings back "Play" for multi-file torrents.
- [ ] **"Open With Prism" for video and audio.** `bundle.fileAssociations` only
  lists `.torrent`. Add media types with role `Viewer`, not as the default
  handler. Handle macOS `RunEvent::Opened`, treating the paths as user-picked
  (`accept_user_pick`), and accept drops on the Dock icon.
- [ ] **Recent files.** Up to 10, stored in Rust, and clearable.
- [ ] **Everyday controls:** audio delay, frame step (`,` `.`), screenshot,
  A-B loop, aspect/zoom, and a `?` shortcut sheet. Each one goes through
  `validate_player_property`; no general passthrough.
- [ ] **Linux player.** Measure the effort before promising it.
- [ ] Subtitle search (OpenSubtitles, user's own API key). Low priority.

### UX (2.5)

- [ ] **Narrow windows.** At 900×600 the sidebar and logo crowd the content.
  Below ~1000px, collapse the sidebar to icons, and keep queue stats on one line.
- [ ] Clear the Dashboard URL box once its item is queued.
- [ ] Torrent file picker: show "Selected X · Y free" and disable Add when it
  won't fit (needs the torrent free-space check).
- [ ] Actions the ledger would refuse are disabled, with the reason as a
  tooltip, instead of failing in a toast.
- [ ] Terminology pass, Settings regroup and search, and one policy for
  destructive actions.
- [ ] Empty-state actions, Library keyboard support, ⌘F, contrast and a 12px
  minimum type size.
- [ ] One add pipeline. Add-time options: clip, start-after, checksum, hold.
- [ ] Bulk retry and edit, per-item speed limit, custom presets, and
  per-subscription options.
- [ ] i18n scaffold (English only at first).

### Features (later, roughly in order)

- [ ] Free-space forecast on the Dashboard (queued and active remaining bytes
  against each destination's free space).
- [ ] Library: "Re-download" and "Locate…" for missing entries. Locate goes
  through a Rust picker that records the new path in the ledger.
- [ ] Sequential "watch while downloading" per torrent. librqbit has no piece
  priorities yet; the stream already prioritizes what it reads.
- [ ] Copy magnet / source link from the Library row menu.
- [ ] Subscriptions: a per-feed regex filter and a dry run.
- [ ] Speed history chart (24h/7d) in Statistics.
- [ ] Capture for unsupported pages (a webview that sniffs media requests).
- [ ] Safari Web Extension (free to build, needs Xcode).
- [ ] Optional LAN web UI: off by default, token-guarded.
- [ ] Torrent creation.
- [ ] Smart mode: one-click defaults.
- [ ] Progress in its own store. Profile a busy queue first; it may not be
  worth it.

### Waiting on someone else

- [ ] Firefox Add-ons and Edge Add-ons submission: needs Rajat's accounts. Steps
  are in `extension/README.md`.
- [ ] winget manifest: once there are Windows users.
- [ ] librqbit 9 has no API for: per-tracker status, adding trackers to a
  running torrent, sequential download or piece priorities, availability,
  moving a torrent, per-torrent limits after add, encryption. The UI says so
  rather than faking it. Upstream PRs only; they never block a release.
- [ ] Sparse/preallocated file control: only if users ask.

### Deliberately not doing

- Paid Apple notarization: ad-hoc signing plus the Homebrew cask instead.
- A custom download engine: yt-dlp is the moat.
- Premium-host accounts à la JDownloader.
- Mobile.

---

## Releasing

1. **Bump the version** in `package.json`, `package-lock.json` (top two
   entries), `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and
   `src-tauri/Cargo.lock`. Write `RELEASE_NOTES.md`.
2. **Branch and PR** (`hotfix/X.Y.Z` or a feature branch). Merge once CI is green.
3. **Tag on main:** `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. **Approve the build.** The three build jobs wait on the `release`
   environment. Approve it under **Review deployments**. A run takes about 17
   minutes.
5. **Check the draft before publishing:**
   - 16 assets.
   - `latest.json` has 9 platforms.
   - Every signature carries key ID `39f3e4ae0ac6fafb`:
     ```sh
     gh release download vX.Y.Z -p latest.json
     python3 -c "import json,base64; d=json.load(open('latest.json')); print({base64.b64decode(base64.b64decode(v['signature']).decode().splitlines()[1])[2:10].hex() for v in d['platforms'].values()})"
     ```
6. **Publish:** `gh release edit vX.Y.Z --draft=false --latest`. Until then, the
   release is a draft and the in-app updater won't see it.
7. **Bump the cask.** In `rajatraina747/homebrew-prism`, edit
   `Casks/prism-downloader.rb`: set `version`, and `sha256` to the
   `shasum -a 256` of `Prism_X.Y.Z_aarch64.dmg`.

### The signing key

The updater installs only what verifies against the minisign public key in
`tauri.conf.json` (`plugins.updater.pubkey`). Whoever holds the private key can
push code to every installed copy.

| What | Where |
|---|---|
| Private key | GitHub → Environments → `release` → secret `TAURI_SIGNING_PRIVATE_KEY`. No repo-level copy. |
| Local copy | `~/.tauri/prism.key` on Rajat's Mac. Keep an offline backup too. If both are lost, no update can ever verify again. |
| Password | None. It would sit in the same environment as the key and add nothing (decided 2026-09-26). |
| Protection | The `release` environment needs Rajat's approval and allows `v*` tags only. A tag ruleset stops anyone but admins creating or moving `v*` tags. |

- **Yearly check:** the backup's `.pub` must match:
  ```sh
  [ "$(cat prism.key.pub)" = "$(jq -r .plugins.updater.pubkey src-tauri/tauri.conf.json)" ]
  ```
- **Rotation takes two releases:**
  1. `npx tauri signer generate -w prism-new.key`.
  2. Release N is signed with the **old** key and ships the **new** pubkey.
  3. `gh secret set TAURI_SIGNING_PRIVATE_KEY --env release < prism-new.key`.
  4. Release N+1 onward uses the new key.
  - If the old key is compromised, ship N fast and remove old releases an
    attacker could replay: the updater has no downgrade protection.

---

## Security model

How to report a vulnerability is in the README. The rules the code follows:

- **The page is untrusted.** Every path the webview names is checked in Rust:
  - `validate_open_path`: inside home, Downloads or a picked folder, and off the
    deny-list.
  - `ledger::require_recorded`: something Prism downloaded.
  - `is_openable_media`: media types only.
  - The exceptions are files the user picked in a dialog Rust showed, or dropped
    on the player (`player::UserPicked`, session-only).
- **Each window gets only its own commands.**
  - `capabilities/default.json` is the main window; `capabilities/player.json`
    is the player.
  - Engine and queue commands are granted to no window.
  - Guarded by `every_command_is_declared_and_granted_to_the_right_window`.
- **Downloads are strangers' files.**
  - They are quarantine-flagged.
  - Every ffmpeg/ffprobe run gets `-protocol_whitelist file,pipe`.
  - mpv runs with `config=no`, `load-scripts=no`, `access-references=no` and
    no ytdl hook.
- **Stream server** (torrent play-while-downloading):
  - Binds 127.0.0.1 on a random port.
  - A 32-byte token per launch, checked in constant time.
  - A `Host` check, and no CORS.
- **Bundled binaries:**
  - Pinned and SHA-256-checked (`scripts/sidecars.lock`).
  - yt-dlp self-updates are checked against yt-dlp's PGP-signed checksum list.
  - The engine's `*.sha256` / `*.tree-sha256` records catch tampering by the
    webview and corruption, not local malware.
- **Licensing:** the media stack is LGPL-only, so there is no x264/x265.
  - Convert and the re-encode use VideoToolbox, NVENC, QSV, AMF, Media
    Foundation, OpenH264 or Kvazaar, whichever works (`encoders.rs`).
  - `media.yml` checks each platform.
- **Upstream issues:** report to yt-dlp, librqbit, mpv or Tauri, unless Prism
  makes the problem worse.

---

## Developing

- **Checks:**
  - `npx vitest run`
  - `npx tsc --noEmit -p tsconfig.app.json`
  - `npx eslint .`
  - in `src-tauri`: `cargo clippy --all-targets -- -D warnings` and `cargo test --lib`
  - `npx playwright test` when UI flows change
  - `PRISM_TEST_FFMPEG=<path> cargo test --lib encoders` exercises a real
    ffmpeg.
- **Audits:** `npm audit --omit=dev`, and `cargo audit` in `src-tauri`. Never
  use `--no-fetch`: that uses a stale database.
- **Gotchas:**
  - Never run `cargo fmt`. The repo isn't rustfmt-formatted, and it rewrites the
    whole crate even when given one file.
  - CI's stable clippy is newer than local rustc, so new lints may only show
    there.
  - Don't `pkill -f vite`: it kills other projects' dev servers.
  - No Co-Authored-By trailers in this repo.
  - `src-tauri/target` grows without bound; prune it now and then.
- **Web demo:** `npx vite --port 8097 --host 127.0.0.1 --strictPort`. Set
  `localStorage.prism_splash_seen = '1'` to skip the splash.
- **Windows build machine**, one-time setup:
  - Install Git for Windows (for Git Bash).
  - Install 7-Zip and add it to `PATH`.
  - Install Node 22+.
  - Install Rust (MSVC toolchain) and Visual Studio Build Tools (C++).
  - Windows 10 also needs WebView2.
  - Then: `npm ci`, `bash scripts/fetch-sidecars.sh windows --player`,
    `npm run dev:tauri`.
  - Keep test data apart with
    `npx tauri dev --config "{\"identifier\":\"com.rainacorp.prism.dev\"}"`.
  - Without the signing key, build with
    `--config "{\"bundle\":{\"createUpdaterArtifacts\":false}}"`.
  - Data is in `%APPDATA%\com.rainacorp.prism\`; the log is in
    `%LOCALAPPDATA%\com.rainacorp.prism\logs\`.

---

## History

What shipped is in git and in each release's notes. The folded-in documents can
be read at commit `d48d7b7`, e.g. `git show d48d7b7:docs/REVIEW-2026-09-28.md`:

- `docs/AUDIT-2026-07.md`, `docs/AUDIT-2026-09.md`: the first audits.
- `docs/REVIEW-2026-09-14.md`, `-09-23`, `-09-28`, `-11-01`, `-11-05`: the
  reviews behind 2.0.x to 2.4.
- `docs/WORKPLAN-2026-11-01.md`: the checklist from the 11-01 review. Phase A
  shipped in 2.3.4; the rest is above.
- `docs/RELEASE-KEYS.md`, `SECURITY.md`: now [Releasing](#releasing) and
  [Security model](#security-model).
- `docs/WINDOWS-TEST-PLAN.md`, `docs/WINDOWS-TEST-RESULTS-2026-09-26.md`: the
  2.3 Windows test pass.
- The previous `ROADMAP.md`: shipped arcs from v1.0 to 2.3.
