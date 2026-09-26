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

## 2.3 roadmap — from the 2026-09-26 third-party review

A fresh, ground-up review of 2.2.1 (no docs or earlier reviews consulted).
Work happens on `roadmap/2.3`, one commit per item below; each phase ends in an
annotated tag `roadmap-pN` and a `--no-ff` merge to `main`, so any item
(`git revert <sha>`) or phase (`git revert -m1 <merge>`) can be undone. Nothing
is released until the build passes hands-on testing on a Windows (AMD x64) PC
(Phase 7). Baseline: tag `roadmap-base`.

### Phase 1 — Critical fixes
- [x] **R1.1** Close to tray (setting, default on) and confirm Quit while work is active.
- [x] **R1.2** "Retries on failure" actually used; manual retry resets the budget; rate limits back off minutes, not seconds.
- [x] **R1.3** A corrupt JSON file is set aside and recovered from `.bak.json`, never silently replaced by `[]`; failed saves are reported.
- [x] **R1.4** yt-dlp stopped with SIGTERM before SIGKILL; stale PyInstaller `_MEI*` folders swept at launch (115 / 8 GB found on one Mac).
- [x] **R1.5** Direct downloads honour a SOCKS proxy.
- [x] **R1.6** Resume disk-space checks count only the bytes still to download.
- [x] **R1.7** A tray that can't be created no longer stops Prism starting.
- [x] **R1.8** Torrent engine falls back to IPv4 / another port when its listen address is taken.

### Phase 2 — Link intake and honest formats
- [x] **R2.1** One lookup (`-J --flat-playlist`) decides video vs playlist for single and batch adds; downloads pass `--no-playlist`.
- [x] **R2.2** Playlist entries keep their own URLs (not forced to YouTube) and the real playlist title.
- [x] **R2.3** Format list shows real codec, fps and HDR; no more "MP4 h264/aac" on VP9/AV1.
- [x] **R2.4** Audio language (dubs) and multi-language / embedded subtitles.
- [x] **R2.5** Batch lookups run in parallel.
- [x] **R2.6** The lookup's info JSON is reused by the download (`--load-info-json`, with fallback).
- [x] **R2.7** Progress read from yt-dlp's raw byte counts, not its formatted strings.
- [x] **R2.8** Download archive for subscriptions.

### Phase 3 — Engine speed
- [x] **R3.1** Bundle yt-dlp's onedir build on macOS and Windows (~5 s → 0.16 s per start); Linux keeps the one-file build (AppImage).
- [x] **R3.2** Engine self-update installs the onedir zip, verified and staged.
- [x] **R3.3** Signing/bundling cover the engine folder on all platforms.
- [x] **R3.4** Start-time test; ffmpeg location cached.

### Phase 4 — Queueing, torrents, subscriptions, Library
- [x] **R4.1** Separate torrent concurrency limit; slow/peerless torrents don't hold slots.
- [x] **R4.2** YouTube subscriptions polled via RSS; parallel checks; premieres/lives held until they air.
- [x] **R4.3** Watch folders take `.torrent` files only.
- [x] **R4.4** Thumbnails cached locally (through the proxy).
- [x] **R4.5** Library marks files that have gone missing.
- [x] **R4.6** Restart the torrent engine from Settings to apply engine settings.

### Phase 5 — Direct downloads and the extension
- [x] **R5.1** Per-item Referer and a browser-style User-Agent option.
- [x] **R5.2** Slow segments are re-split across free connections.
- [x] **R5.3** Extension: "Download link with Prism" on links.

### Phase 6 — Queue owned by Rust, stored in SQLite
- [x] **R6.1** SQLite store; one-time copy of queue/history/stats JSON (JSON kept).
- [x] **R6.2** Rust `QueueManager`: transitions, scheduling, retries, quiet hours, when-done.
- [x] **R6.3** The UI becomes a view of Rust's queue.
- [x] **R6.4** Retire the finished journal (Rust saves completions at once) and Rust's reading of `queue.json` (R6.1); `jobs.rs` tickets stay — they still guard a stop that lands while an engine starts.
- [x] **R6.5** No 2,000-entry cap (since R6.1). Paging deliberately not built: 20,000 rows load and serialise in 37 ms (13 MB; `store::tests::library_load_time`), and the list is virtualized.
- [ ] **R6.6** Torrents reach the Library when downloaded, marked Seeding.
- [ ] **R6.7** Reducer tests ported; migration test.

### Phase 7 — Windows hand-off
- [ ] **R7.1** `docs/WINDOWS-TEST-PLAN.md`; tag `roadmap-complete`.

## Arcs from the 2026-09-23 review

Full findings in [docs/REVIEW-2026-09-23.md](docs/REVIEW-2026-09-23.md), a
whole-tree review of 2.0.0. IDs below are that document's. Each fix lands with a
regression test at the seam the review names — no existing test would have
caught B-1 to B-5. Order decided 2026-09-23: the P0s ship alone and fast, the
rest of the hardening follows, and the 2.1 features wait for both.

### v2.0.1 — "Don't lose it, don't destroy it" (shipped 2.0.1)

- [x] **B-1** Queue saved while downloads run. A change to which items exist
      or their status saves at once; progress alone is throttled (2 s
      `maxWait`); the reducer returns the same array for events it ignores. A
      flush on quit was dropped: ⌘Q reaches Rust only as `RunEvent::Exit`,
      too late to wait on the webview (`stores/queue-save.ts`).
- [x] **B-2** Finished torrents leave the librqbit session once seeding ends
      (`delete(id, false)` before the move). Torrents that already leaked are
      **paused** when the session restores them, not deleted: `add_or_adopt`
      unpauses the ones a queue item adopts, and deleting one a queued item
      still wants would cost a full re-hash (`pause_restored`).
- [x] **B-3 + S-3** `resolve_completion_path` never falls back to the shared
      destination; `trashable_paths` refuses every root and every ancestor of
      one, which also neutralises rows already recorded with a folder path.
      Protected: home and the standard user folders, picked roots, and from
      settings the default folder, move-completed folder, category
      destinations and watch folders. The Library sends only what
      `trashTarget` allows.
- [x] **B-4** Direct downloads reserve their file name per id, as yt-dlp's
      `reserved` map does, and resume only a partial file whose state names
      the same source (`choose_destination`).
- [x] **B-6** `convert::kill_all()` in the Exit handler.
- [x] **B-10** Escape `%` in the folder part of yt-dlp's `-o`, and unescape
      it wherever Prism turns the template back into a path
      (`template_file`). That also fixes finding the file for any title
      with a `%` in it.
- [x] The Trash dialog names any folder it is about to trash.

### v2.0.2 — Player fix, correctness & security hardening (shipped 2.0.2)

- [x] **The macOS player never started in 2.0.0 or 2.0.1** (found while
      checking S-7). The LGPL libmpv shipped since 2.0 is built without Lua,
      so `osc`/`ytdl` don't exist, and the wrapper fails create on an option
      it can't set. `player.rs` reads the bundled libmpv's embedded
      `-Dlua=disabled` and sets them only when Lua is there (Windows' build
      has it). Verified with `examples/mpv_thread_repro` against the shipped
      libraries; it hung at create before.
- [x] **B-5** One ticket per start (`jobs.rs`), taken before the first
      await; every engine's cancel marks it and each engine checks it before
      registering. The frontend also stops before invoking when cancelled
      during setup.
- [x] **B-7** yt-dlp prints `after_move:PRISM:PATH=%(filepath)s` and
      completion uses it (split chapters too); yt-dlp runs with
      `PYTHONIOENCODING=utf-8`.
- [x] **B-8** Content index read-modify-write under a mutex, on the blocking
      pool.
- [x] **B-9** A 206 must start where it was asked to, or the download fails.
- [x] **S-1** Text-list links from watch folders go through the
      confirmation card; a watch folder may not be a download destination;
      text files with no links are left unrenamed.
- [x] **S-2** App-command ACL manifest (`build.rs`) with per-window grants;
      the player window can't emit events. Tests cover both.
- [x] **S-4** `storage_summary` validated and on `spawn_blocking`.
- [x] **S-5** RSS polls use a SOCKS proxy too (reqwest's `socks` was already
      compiled in by librqbit).
- [x] **S-6** Bound line length in `spawn.rs` `forward`.
- [x] **S-7** `access-references=no`. The review's
      `protocol_whitelist=file` does not work: mpv parses `#EXTM3U` itself,
      and still fetched the entry with it set. Play now is unaffected.
- [x] **P-1 (part one)** Memoized context values and `queueRef` in callbacks,
      so `QueueRow`'s memo holds.
- [x] **P-2** Remaining blocking work onto `spawn_blocking`.
- [x] Completion reads the current settings, not the ones captured at start.
- [x] A title with `%` is no longer escaped twice: `sanitizeFilename` makes
      a name and `-o` is escaped once, with `ytdlpLiteral`.

### v2.0.3 — The macOS player, fixed properly (shipped 2.0.3)

- [x] 2.0.2 still set `osc` from the fixed option list, so a Lua-less libmpv
      kept refusing init. Found with an lldb trace of the real app
      (`mpv_set_option("osc")` → -5); `fixed_options(has_lua)` is now pure and
      tested. Confirmed by Rajat: YouTube downloads play in Prism on 2.0.3.

### v2.1 / v2.2 — Export, import, dedupe (shipped 2.1.0), and the structural fixes (shipped 2.2.0)

- Shipped early as **2.0.4** (2026-09-24): the Dock icon, updater progress,
  player close and player error hint fixes below.
- [x] The player window can't be closed while mpv's init hangs: the vendored
      libmpv plugin holds its `instances` lock across `mpv_wrapper_create`, and
      the close handler's `try_lock` then refuses. Create outside the lock.
- [x] The Dock icon turned into mpv's once a video played, until Prism quit:
      mpv's macOS output sets its own icon unless `MPVBUNDLE=true`
      (`player::keep_prism_dock_icon`, measured with the harness).
- [x] Updater UI: Settings shows only "Installing…" although
      `app-update-progress` is emitted; show the percentage. A second click
      starts a second download beside the first; refuse while one runs.
- [x] The player's startup-failure screen always says reinstalling Prism
      restores libmpv (`src/pages/Player.tsx`, the `initError` branch). That is
      wrong when the engine hung or refused its options, as in 2.0.0–2.0.1:
      offer the reinstall hint only when the library is missing, and
      otherwise point at updating and at `mpv.log`.
- [x] Settings/Library export and qBittorrent/Transmission import (the open
      line under v2.0 → Library): `stores/backup.ts` + `open_backup_file`;
      `client_import.rs` + Settings → BitTorrent → Import torrents.
- [x] yt-dlp `id`/`extractor` dedupe extension: `mediaKey` on lookups,
      checked after the lookup (single and batch); not for the `Generic`
      extractor, whose id is just a file name.
- [x] A completion ledger owned by Rust: open, trash, convert and index accept
      only paths an engine recorded (review Idea #1). The 2.0.1 root refusal
      stays as a second layer. `ledger.rs` (in `app_data/ledger/`, out of the
      page's fs scope), seeded once from the Library; the player takes
      unrecorded files only through `player_open_file`, a Rust-side dialog.
- [x] Queue persistence in Rust (Idea #3); queue-state loss has caused the
      worst bug twice. Done as the part that matters: `finished.rs` writes
      every successful completion down as Rust emits it (in `app_data/ledger/`),
      and the queue applies it as it loads, before anything can start, so a
      finished download never starts again whatever the page's save reached.
- [x] **P-1 (rest), part:** Transfers virtualized past 100 rows (`QueueTable`
      through `VirtualList`, with a test).
- [ ] **P-1 (rest), open:** progress in its own store. Since part one, callbacks
      are stable and `QueueRow` is memoized, so a tick re-renders only the row
      that changed; a separate store is a large queue-state refactor for a
      gain nobody has measured. Profile a busy queue in the real app first.
- [x] **P-3** Torrent bytes as a raw IPC body (name in a percent-encoded
      header; `torrent_upload` tested with Tauri's own body and header types).
- [x] Clear the 11 fast-refresh lint warnings (lint is now 0 warnings) and
      review the 8 `cargo audit` warnings (2026-09-24). None fails CI or has a
      known exploit on a path Prism uses; none is fixable from this repo alone:
      - `glib` 0.18 (unsound `VariantStrIter`) and `proc-macro-error`: Tauri's
        Linux-only GTK stack; Prism never calls that iterator. Goes when Tauri
        moves off gtk-rs 0.18.
      - `unic-char-property`, `unic-char-range`, `unic-common`, `unic-ucd-ident`,
        `unic-ucd-version`: via `urlpattern` in tauri-utils. Unmaintained, not
        vulnerable; goes with a Tauri upgrade.
      - `crypto-hash`: librqbit's default SHA-1 backend. librqbit's `rust-tls`
        feature would swap in `aws-lc-rs` (a large C/asm crypto build with its
        own Windows/Linux toolchain needs) and change its HTTPS stack. Not worth
        that risk for an "unmaintained" notice; revisit if it becomes a real
        advisory or librqbit changes its default.

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

### v2.0 — "Download manager" (shipped 2.0.0)

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
- [x] Storage tile: what the download folder is holding and what its disk has
      left, shown above the setting that chooses that folder. The walk is
      capped by depth and by entries — the folder is wherever the user pointed
      Prism, which can be a network share or an enormous tree — and when it
      stops early it says "at least" rather than reporting a wrong total
      confidently.
- [x] Library sort, grid view, density modes. The plan called for extracting a
      `useListModel` from Transfers, which turned out to be the wrong shape:
      that logic already lives in `stores/transfers.ts` as pure functions the
      Library was reusing. So `stores/library.ts` follows the same pattern —
      `sortHistory` and `gridColumns`, pure and unit-tested — rather than
      wrapping what exists in a hook to satisfy the word "model". The grid is
      the virtualizer's lanes, not a second list: doing it only in the
      non-windowed path would have meant grid silently stopping at 60 rows.
      Column count comes from the measured width, so a narrow window gets one
      readable column instead of three cramped ones, and density applies to
      Transfers as well.
- [x] Bulk "move to Trash" — the first thing in Prism that removes a file
      someone downloaded, so it goes to the OS Trash rather than being
      unlinked: the Trash is the undo, which is why no Undo toast is offered.
      The Clear dialog's promise that downloaded files stay on disk is still
      true — Clear removes records only, and this is a separate action that
      says outright what it does. Every path is validated in Rust against the
      allowed roots, and only a file or a torrent's own folder is ever a
      target: never `settings.destination`, which is the whole download folder
      and would take every other download with it.
- [x] Undo that resumes. The premise here was wrong in a useful way: partial
      files were never lost on cancel. `cancel_download` only stops the
      process, yt-dlp is already given `--continue`, and the direct engine
      keeps its `.prismpart` and state file (the deletions in `http_engine.rs`
      are a checksum mismatch and post-rename cleanup, not cancellation). What
      actually restarted was the *display*: the undo handler re-queued with
      `progress: 0, downloadedBytes: 0`, showing a fresh start the engine was
      never going to perform. The counters now carry over. Torrents are paused
      for the length of the toast instead of cancelled, so undo keeps the
      engine's handle and costs no hash re-check, with the real cancel fired
      when the toast closes. Not verified by hand: proving a resume needs a
      live download in a running build.
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
- [x] Global shortcuts: optional system-wide hotkeys for add-from-clipboard,
      show Prism, and pause everything. All three default to empty — a global
      shortcut is taken away from every other application for as long as Prism
      runs, so it claims none on its own. Registered in Rust, so the web view
      is never granted the ability to bind arbitrary keys. The handler fires on
      press and release, so it acts only on the press; collisions are caught on
      the parsed key's id, which sees "Cmd+P" and "CommandOrControl+P" as one
      key. "Show Prism" never reaches the page — the point of it is to work
      while the window is hidden, and a hidden web view can't raise itself.
- [x] Dock and taskbar progress. `stores/progress.ts` decides the number and
      Rust only shows it. Weighted by bytes when every running download knows
      its size, so one large file isn't drowned out by several small ones —
      and the mean of their own percentages when any size is still unknown,
      because mixing the two scales makes the bar jump backwards the moment a
      size arrives. Seeding is excluded (the download is finished, and a bar
      stuck at 100% reads as stuck), and nothing running hides the bar rather
      than leaving it full. Pushed only when the shown value changes: the
      queue ticks several times a second and every push is an IPC call.
- [x] Scheduling, both halves. Quiet hours now take chosen weekdays
      (`scheduleDays`, none chosen = every day, so an existing schedule is
      unchanged), and an overnight window belongs to the evening it *started*
      on — with 22:00→06:00 and Monday picked, the small hours of Tuesday are
      still Monday's window, which is what "quiet hours on Monday night" means
      to a person. Per item, `startAt` holds one download back without
      blocking the queue behind it: it filters the start list rather than
      gating the whole effect, so a download set for midnight doesn't stop
      everything else, and the existing minute tick starts it when its time
      comes. Set in Settings (a weekday row) and per download (Detail panel →
      Start after), which only appears while an item is still queued — a start
      time on something already running describes a moment that has passed.
- [x] Content-level duplicate detection, in the half that is actually
      answerable. `content_index.rs` keys a finished file on its size plus a
      SHA-256 of its first and last 4 MB, and reports "you already had this"
      when the same content has landed before under another name or from
      another URL. The plan put this at *add* time with an "Open existing /
      Add anyway" prompt; that can't work as described, because before a
      download there is no file to hash — only a URL, and URL-level dedupe
      already exists (`sourceKey`: magnet infohash, YouTube id). Hashing only
      the ends is a deliberate trade against re-reading gigabytes for a
      convenience feature, and its blind spot — two files of equal length
      differing only in the middle — is written down in a test rather than
      left to be discovered. The index is capped, not uncapped as planned:
      an install that runs for years shouldn't grow one without bound.
- [x] Open, from the same idea: capture yt-dlp's `id`/`extractor` at parse so
      dedupe works on sites where `sourceKey` has no special case. Not free —
      `YtDlpInfo` requests neither field, so it needs a parse-struct change, a
      new `MediaMetadata` field and a `sourceKey` extension, and it only adds
      anything beyond YouTube and magnets, which are already normalised.
- [x] Native menu bar with accelerators (`app_menu.rs`): Add Link (⌘N) and a
      Go submenu for the five pages and Settings (⌘1–⌘5, ⌘,). Built by
      *extending* `Menu::default` rather than replacing it — on macOS the menu
      is where the webview gets ⌘C, ⌘V and ⌘Z, so a hand-assembled one takes
      them away from every text field in the app, which is the sort of thing
      that goes unnoticed until someone tries to paste a URL. A menu item
      names an intent and the shell decides what it means, so navigation still
      goes through the one bus that owns it instead of a second path. Not yet
      seen on screen: the table is unit-tested (unique ids and accelerators,
      routes well-formed) but a menu bar can only really be checked by looking
      at it.
- [x] Decided, and added: `rss_fetch` (reqwest + `feed-rs`). yt-dlp does read
      RSS and Atom, but it returns each entry's *page* — and for a podcast or
      torrent feed the thing to download is the `<enclosure>`, a file or a
      magnet, which never reaches the queue that way. That is what the second
      path buys, and it is why the dependency was worth taking. It returns the
      same shape as `parsePlaylist`, so the seen set, the keyword rules and the
      category are untouched and don't know which fetcher ran; a subscription's
      type is guessed from its URL and falls back to the other fetcher, so
      pasting a URL still just works. Enclosures live in different places per
      format — Atom in `links` with a rel, RSS 2.0 wrapped as media content and
      not in `links` at all — and handling only one fails quietly, queueing
      every entry's web page. Both are covered by tests.
- [x] Statistics page (`stores/stats.ts`): counters kept as their own record,
      not a view of the Library, which is capped at 2,000 rows and forgets —
      seeded once from whatever history exists and updated where terminal
      items are archived, the one place every finished download passes through
      while its engine and uploaded bytes are still known. Upload is shown as
      a since-this-version figure rather than a lifetime one, because nothing
      in history records it. Charts are hand-drawn SVG, as the player's speed
      graph already is; no charting dependency.
- [x] Clip download and chapter split. A range is typed as `1:23` / `0:01:23`
      / `83`, with either end optional, and `clip.rs` turns it into yt-dlp's
      `--download-sections "*start-end"`. The range is rebuilt from the parsed
      seconds rather than echoed back, so what reaches yt-dlp is something
      Prism produced — arguments go to argv rather than a shell, but a range
      is user text reaching a command line and the narrow rule is cheap. Tests
      cover the injection-shaped inputs. `--force-keyframes-at-cuts` goes with
      it so a cut lands where it was asked for instead of at the nearest
      keyframe. `--split-chapters` applies only when there is no range:
      splitting the chapters of an excerpt describes two different cuts of one
      file. Offered on yt-dlp items only (the flag means nothing to the
      torrent or direct engines) and only while queued. Not verified by hand —
      proving a cut lands at 1:23 needs a real download.
- [x] Conversion presets (`convert.rs`, `kind: 'convert'`). Six destinations —
      MP4/H.264, MP4/HEVC, MP4 remux, MP3, M4A, Opus — rather than a codec
      matrix, because every extra option is one more way to produce a file
      that won't play. The module decides only what to run and what ffmpeg
      said, both pure, so the argument building and the progress arithmetic are
      tested without spawning anything. Running it goes through `spawn.rs` like
      every other child, so stopping one takes the process group on unix and
      the Job Object on Windows instead of leaving ffmpeg behind; `running()`
      tracks conversions by id and `cancel_convert` is a no-op for an id it
      doesn't own, so the frontend can signal every engine without knowing
      which one holds the job.
- [x] Settings/Library export and qBittorrent/Transmission import (shipped in
      2.1.0; the rest of this entry is how it looked before). Both still
      genuinely absent: no `prism-export`, and no `.fastresume` reader — the
      only `fastresume` in the tree is librqbit's own session persistence,
      which is a different thing.

**Distribution**
- [x] Chrome/Edge and Firefox extension builds (`scripts/build-extension.mjs`,
      one `src/background.js`, base + per-browser manifests; `web-ext lint` in
      CI; a Playwright test loads the Chromium build; each release attaches
      both zips) and the hosted privacy page (rainacorp.co.uk/prism/privacy).
- [ ] Submitting to Firefox Add-ons and Edge Add-ons: needs Rajat's accounts;
      steps in `extension/README.md`. winget waits for Windows users.
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
- [x] **Watch folder.** `watch.rs` polls the folders the user chose (started
  from setup) and emits `watch-folder-links`, which the frontend feeds into the
  ordinary add flow — so dedupe, categories and confirmation are the ones that
  already exist rather than a second path beside them. Polling rather than the
  `notify` crate on purpose: a watch folder is often a network share, where
  filesystem events are unreliable. It picks up `.torrent` files and text files
  of links, doesn't descend into subfolders, and renames what it has handled
  instead of deleting it.
- [x] **Move completed to folder.** `postprocess.rs`, wired into all three
  engines. The move runs *before* completion is reported, so the Library
  records where the file actually ended up instead of a path that is already
  wrong — which is what keeps "Show in folder" and "Move to Trash" pointing at
  a real file. Torrents move when seeding ends rather than when the download
  finishes, because librqbit holds the file handles until then: a multi-file
  torrent owns its folder and moves as one, a single-file torrent moves only
  its own file out of the shared destination, and the recorded path is rebased
  onto the new folder.

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
- [x] Spawn yt-dlp in its own process group (`spawn.rs`: `tokio::process` with
  `process_group(0)`, signalled with `killpg`). Windows has no process groups,
  so a run is put in a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
  instead — closing the one handle takes the whole tree with it. The
  `ps`-snapshot tree kill in `proc.rs` was kept as a fallback rather than
  removed: it still catches a stray descendant that escapes the group.
- [x] Run the Playwright suite in CI against the web demo (1.9.0).

## Explicitly deferred

- Paid Apple notarization (ad-hoc signing + Homebrew cask for now).
- Multi-language UI, theming, mobile.
- Custom download engine — yt-dlp is the moat; Prism's value is the experience
  around it.
- Account/premium-host handling à la JDownloader — maintenance tarpit, outside
  Prism's identity.
