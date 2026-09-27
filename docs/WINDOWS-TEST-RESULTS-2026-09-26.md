# Windows test results: roadmap-complete (ebe08d8), 2026-09-26

Run of `docs/WINDOWS-TEST-PLAN.md` on the Windows PC.

- **Machine:** Windows 11 Home 26200, AMD Radeon iGPU + NVIDIA GTX 1650 Ti (Prism set to the NVIDIA GPU
  via Windows' per-app GPU preference).
- **Build:** local `npx tauri build` without updater artifacts; NSIS installer installed over 2.2.1 (per-user).
- **Method:** most rows were driven through the app itself (WebView2 remote debugging + Playwright), with
  files, logs, `ffprobe`, `nvidia-smi` and hashes used to check results.

## Fix status (roadmap/2.3, 10 commits after 8dadb47, 2026-09-27)

Every issue below is fixed and re-checked on this PC with a fresh NSIS build, except where noted. Suites
on Windows: Rust **255 passed / 0 failed** (they could not start before), Vitest **397/397**, Playwright
**26/26**, ESLint and `clippy -D warnings` clean.

| # | Fix | Re-checked on the final build |
|---|---|---|
| 1 | Ledger keys paths one way (`c146ff1`) | E1 Play, F1 (NVIDIA decode), Open in default player, Missing badge (E5), Move to Recycle Bin |
| 1+ | Trash guard compared verbatim vs stripped paths, so it never fired; now also keeps OneDrive-redirected home folders (`c146ff1`) | unit tests |
| 2 | 403 refetches from the URL even after bytes; one auto-retry; wording (`09b6658`) | unit tests; D5 downloads (a 429 on subtitles was retried after 60 s and finished) |
| 3 | Installer hook re-stamps shortcut AppUserModelID (`036a1e7`) | shortcut went com.prism.app → com.rainacorp.prism; C1 notification delivered |
| 4 | Formatless generic lookups download as files (`9df4e1f`) | the `.dat` link downloaded (10 MB) |
| 5 | Exclusive-bind probe before the torrent session (`dbeea1e`) | unit test reproducing qBittorrent's per-address binds; the old fallback test now passes |
| 6 | Adopted torrents start after their restore check (`dbeea1e`) | D13: 34 peers 5 s after Restart engine; relaunch mid-torrent resumes at once |
| 7 | Cancel discards per engine; moves tidy up (`29d27b1`, `84f1c66`, `752de9d`) | running video, paused-then-cancelled video, 756 MB direct (part + state), torrent, peerless magnets: nothing left |
| 8 | Installer removes 2.2.1's `yt-dlp.exe` (`036a1e7`) | gone after install |
| 9 | Retry waits count down on the row (`29d27b1`, `c9e1f8d`) | local 429 server: "Retrying in 0:47 — Rate limited by the site" |
| 10 | Lists over 100 open unselected (`c9e1f8d`) | @BlenderOfficial: "Select all (0/1212)", Queue disabled |
| 11, 28 | Windows wording: Recycle Bin, "this computer", VP9 note (`c9e1f8d`) | seen in the app |
| 12 | Picker titles per purpose (`c9e1f8d`) | watch-folder picker title |
| 13 | `prism.bak.db` + restore-from-backup + honest message (`c9e1f8d`) | G2: "Restored your queue and Library from a backup" (the backup is per clean launch, so that session's changes aren't in it) |
| 14 | Move keeps template subfolders (`29d27b1`) | E2 with Move: `Prism-moved\e2test\deeper\…`, source folders removed |
| 15 | Clipboard offer remembered across launches (`c9e1f8d`) | no re-offer on relaunch |
| 16 | Launch link remembered for the session (`c9e1f8d`) | card not back after a real reload |
| 17–19 | Pause/resume/cancel, seeding, and page-side data-file recovery logged (`29d27b1`, `c9e1f8d`) | seen in Prism.log |
| 20–24 | Test plan corrected (`c9e1f8d`) | — |
| 25 | Test manifest for every binary; Windows CI runs `cargo test --lib` (`c146ff1`) | 255 tests run and pass locally; CI not yet run (not pushed) |
| 26, 27 | One Library row can go to the Recycle Bin; Missing rows excluded (`c9e1f8d`) | single row moved to the Recycle Bin |
| 29 | No `.srt` copies beside embedded subtitles (`c9e1f8d`) | D5: one file with eng + spa tracks |
| — | Extension build falls back to Windows tar (`77bcf9c`) | extension e2e passes on Windows |

## Full re-run on the merged build (2026-09-27)

Every row re-run on the final code (main after PR #18, plus #30 below), on this PC:

| Rows | Result |
|---|---|
| A1, A2 | PASS — real 2.2.1 installed from the v2.2.1 release, one download finished and one paused at 35%, then the new build installed over it: JSON untouched, "copied the JSON data into prism.db", 7 Library entries and the paused item kept, nothing restarted, `prism.bak.db` created, 2.2.1's `yt-dlp.exe` removed. The paused item later resumed from its 2.2.1 partial and finished byte-exact. |
| B1, B2 | PASS — dialogs in 5–8 s; no new `_MEI` folders |
| B3 | PASS — test build bundling yt-dlp 2026.07.04: "2026.08.19 is available"; updated while a download ran (the download kept going); a download that the old engine got 403 on succeeded after the update. |
| C1–C4 | PASS — hide + notification; X with the toggle off asks; Keep running / Quit; idle quit is immediate; no orphaned yt-dlp |
| D1–D13 | PASS — incl. D7 kill at 60.7% → resumed, byte-exact; D9 Seeding tag, move, SHA-256; D10 resume from byte 41,679,620; D11 via socks5h |
| E1–E6 | PASS — E3's Explorer selection lags in a OneDrive folder (folder opens; file selected on a second try), which is Explorer's |
| F2, G1–G3, G5 | PASS |

30. **Sites that don't report a codec had no qualities** (found re-testing B3): archive.org's formats have no
    `vcodec`, `formats::options` read that as audio-only, and the dialog's Add stayed disabled. Fixed on
    `windows-green`; archive.org now offers 720p / 360p / 300p and downloads.

Still for a person: A3 (SmartScreen on a downloaded installer), F1 (watching colours and smoothness), G4
(sleep / shut down the PC).

## Summary

| Section | Pass | Fail | Other |
|---|---|---|---|
| A. Install and upgrade | A1, A2 | | A3 not testable with a local build |
| B. Engine | B1, B2 | | B3 partial (no newer yt-dlp to install) |
| C. Window, tray, quit | C2, C3, C4 | C1 | |
| D. Downloads and queue | D1–D4, D6–D11 | D12, D13 | D5 blocked by #2 |
| E. Files and paths | E1*, E2, E3, E4, E6 | E5 | *E1 "Play" fails via #1 |
| F. Player | F2 | | F1 blocked by #1 |
| G. Settings, recovery | G1, G2, G3, G5 | | G4 left for a person (sleeps/shuts down the PC) |

## Results

| ID | Result | Notes |
|---|---|---|
| A1 | PASS | `prism.db` created; `queue.json`/`history.json` byte-identical to the pre-upgrade hashes; log "copied the JSON data into prism.db" |
| A2 | PASS | nothing re-downloaded |
| A3 | N/A | a locally built installer has no Mark of the Web, so SmartScreen never triggers; needs a browser-downloaded installer |
| B1 | PASS | details dialog in ~5 s |
| B2 | PASS | no new `_MEI…` folders after several downloads, pauses and a cancel |
| B3 | PARTIAL | engine already current (2026.08.19); the install and "engine in use" paths are untested |
| C1 | FAIL | window hides and the download carries on, but no "still running" notification (#3) |
| C2 | PASS | tray Quit asks "Quit Prism?"; Keep running and Quit both work; no orphaned yt-dlp. Ctrl+Q is macOS-only (#23) |
| C3 | PASS | with "Keep running…" off, ✕ asks instead of hiding |
| C4 | PASS | idle quit is immediate |
| D1 | PASS | video, playlist (43), channel (Videos tab), Mix (single video) |
| D2 | PASS | 5 pasted items queued in order, playlist entries in order |
| D3 | PASS | "2160p60 · VP9", "1080p60 · H.264"; HDR only ≥ 1080p on a video with HDR down to 144p; VP9 note shown |
| D4 | PASS | 22 audio options, "English · original" first; Spanish/Chinese downloads carry `spa`/`zho` tracks |
| D5 | BLOCKED | every attempt with subtitles gets HTTP 403 and never falls back (#2) |
| D6 | PASS | 5-item queue drained with the window hidden; all reached the Library (one 403, #2) |
| D7 | PASS | killed at 53%: yt-dlp exited with Prism; auto-resumed from 131 MB; file byte-identical to an uninterrupted download |
| D8 | PASS | 3 peerless magnets held the torrent slots; the video started 3 s later |
| D9 | PASS | Library tagged Seeding while seeding; tag cleared and file moved when the seed limit ended; SHA-256 matches Debian's |
| D10 | PASS | ranged download over 4 connections; resume logged "resuming 1228208 of 104857600 bytes"; recovered after HTTP 429 back-off |
| D11 | PASS | `socks5h://` proxy: 4 connections by hostname through the proxy; update check went through it too |
| D12 | FAIL | with qBittorrent on 4240, Prism still binds 4240 and shows "Port 4240"; no fallback (#5) |
| D13 | FAIL | new port applied and progress kept, but the torrent sat at 0 peers for 2+ min (#6) |
| E1 | PASS / FAIL | `: \| "` become `#`; Show in Folder opens Explorer with the file selected; **Play fails** (#1) |
| E2 | PASS | a ~300-character path downloaded fine |
| E3 | PASS | download into a OneDrive folder; Show in Folder selects the file |
| E4 | PASS | `Zone.Identifier` ZoneId=3 on a video, a direct file and a torrent file |
| E5 | FAIL | deleted file never shows **Missing** (#1) |
| E6 | PASS | `magnet:`, a `.torrent` file and `prism://add?url=…` each reach the confirmation card |
| F1 | BLOCKED | Library Play is refused (#1), so finished files can't be played |
| F2 | PASS | torrent Play now streams at ~20% downloaded; seek to 6:07 fetched the right pieces; hardware-decoded on the NVIDIA GPU (decoder ~10%) |
| G1 | PASS | "Restored your settings from a backup"; `settings.corrupt-….json` kept; values intact |
| G2 | PASS | "Couldn't read your queue and Library"; `prism.corrupt-….db` kept (see #13 on the wording) |
| G3 | PASS | direct download works with "Identify as a browser" on and off |
| G4 | NOT RUN | puts the PC to sleep / shuts it down — for a person to run |
| G5 | PASS | taskbar progress bar while downloading; turns yellow when paused |

Rust unit tests (`cargo test --lib`) and the web tests: see the end of this file.

## Issues

### Bugs

1. **[Highest] The download ledger never matches on Windows, so every ledger-gated action fails.**
   `Ledger::record` stores `path.canonicalize()`, which on Windows is a verbatim `\\?\C:\…` path (see
   `ledger/finished.json`). `validate_open_path` returns `canonical_string()`, which strips `\\?\`
   (`lib.rs:1015-1022`), and `require_recorded` looks the stripped path up in the verbatim index, so it
   never matches. `ledger::missing` looks up un-canonicalised paths, so it never matches either.
   Confirmed on Windows:
   - **Play in Prism** → "Prism only does this with files it downloaded" (for `d7-kill4.mp4`, which this
     build downloaded and which *is* in `finished.json`).
   - **Open in default player** → same toast.
   - **Missing** badge never appears after deleting a file (E5).

   By the same code path: `move_to_trash` (Remove and delete files), `convert_file`, `index_download`.
   macOS and Linux have no verbatim prefix, which is why Mac testing and CI wouldn't catch it.
   Fix: compare one form everywhere (e.g. `dunce::canonicalize` for both record and lookup), plus a
   Windows test. Related: 2.2.1-era downloads are never added ("ledger: seeded 0 path(s) from the Library").

2. **An HTTP 403 from a stored lookup is terminal once any bytes are written.**
   `download_manager.rs:585` only falls back to a fresh extraction when `agg.bytes() == 0`.
   - With subtitles on, the `.srt` files download first, so the fallback never runs and Retry can never
     succeed (D5: three attempts, all 403).
   - A 403 mid-file (Big Buck Bunny, 19 MB in, after ~3 min in the queue) also fails outright.

   A manual Retry without subtitles falls back and finishes, so a fresh extraction fixes it.
   Fix: on a 403 from a lookup-started run, fall back once whatever was written (yt-dlp resumes the `.part`).
   Related: 403 isn't auto-retried despite "Retries on failure = 3", and the error text ("update the engine
   in Settings → Updates") is the wrong advice when the engine is current.

3. **No notifications after upgrading from a pre-rename install (C1).** The Start-menu `Prism.lnk` keeps
   AppUserModelID `com.prism.app`; the app posts toasts as `com.rainacorp.prism`, which has no shortcut,
   so Windows silently drops every toast (still-running, download finished, …). The NSIS upgrade should
   re-create or re-stamp the shortcut with the current identifier. Probably affects 2.2.1 too.

4. **Unrecognised direct links are a dead end.** `https://proof.ovh.net/files/10Mb.dat` goes to yt-dlp's
   generic extractor, which returns a "video" with no formats: the dialog shows "10Mb · 0:00 · .mp4",
   no quality rows, and a disabled **Add to Queue**. The "download as a file" fallback only runs when
   yt-dlp fails outright. Offer it when the lookup has no formats (or probe the URL first).

5. **Listen-port fallback never triggers on Windows (D12).** qBittorrent binds 4240 on each address
   (192.168.1.149, 127.0.0.1, IPv6); Prism binds `[::]:4240`, which Windows allows alongside them. Prism's
   bind "succeeds", no fallback happens and the UI shows "Port 4240", but inbound peers to the machine's
   real addresses reach qBittorrent, so Prism silently gets no incoming connections.
   Fix: `SO_EXCLUSIVEADDRUSE` on Windows, or probe the concrete addresses before accepting the port.

6. **Torrents don't reconnect after "Restart engine" (D13).** Log: "torrent engine restarted (1 torrent(s)
   were running)" / "1 torrent(s) go back in line"; the torrent then showed "searching for peers…",
   0 peers, 0 B/s for 2+ minutes (103 peers before). A manual Pause → Resume brought back 57 peers in 15 s.
   Right after that resume the row briefly showed 422.5 MB / 55.9% before settling at 188 MB.

7. **Cancel and move leave files and folders behind.**
   - A cancelled video left `…f137.mp4.part` and its `.webp`.
   - A cancelled direct download left a full-size preallocated `1GB.bin.prismpart` (1 GB) + `.prismpart.json`.
   - Cancelled magnets left empty `d8-dead-1..3` folders.
   - "Move finished downloads" leaves the torrent's empty `debian-…iso [7acf8fb5]` folder, and the empty
     template subfolders (E2).

8. **Upgrade leaves the old one-file engine:** `%LOCALAPPDATA%\Prism\yt-dlp.exe` (17 MB, 2.2.1's onefile
   build) stays beside the new `ytdlp\` folder. Unused (no `_MEI` appeared), but the installer should remove it.

### UX / copy

9. **Rate-limit back-off shows a frozen "downloading" row.** During a 300 s HTTP 429 back-off the row kept
   "DOWNLOADING · 141 KB/s · ETA 3m" for ~5 min. It should say it's waiting, and why.

10. **Channel list pre-selects everything.** @BlenderOfficial: "Select all (1212/1212)" ticked by default,
    so one click queues 1,212 downloads; the list took ~33 s to appear.

11. **macOS copy on Windows.**
    - VP9 note: "plays in VLC, IINA and browsers, but not in QuickTime or Photos" (IINA/QuickTime are Mac
      apps; Windows 11 Photos/Media Player do play VP9).
    - Storage → Back up settings and Library: "…stay as they are on this Mac".

12. **"Move them to" picker has the wrong title**: it reuses "Choose where Prism saves downloads"
    (`pick_download_dir` has one hard-coded title for both buttons).

13. **After a corrupt `prism.db`, the toast doesn't match what happens (G2).** It says "there was no backup,
    so Prism started it fresh", but the log shows it re-imported the old 2.2.1 JSON files, so the Library
    silently rolls back to its pre-upgrade state. There's also no `prism.db` backup, unlike `settings.bak.json`.

14. **"Move finished downloads" flattens template subfolders**: a `a/b/c/{title}` download moved to
    `Prism-moved\Me at the zoo.mp4`. Probably intended, but the setting doesn't say so.

15. **The clipboard watcher re-offers the same link on every launch** ("Video link on clipboard" for the
    same URL each start).

16. **An ignored external-link card comes back after a webview reload**: the launch deep link is replayed on
    each page load. Low impact (users rarely reload), but the card is modal and blocks the window.

### Found while fixing (after the ledger fix made these reachable)

26. **A single Library item can't be moved to the Recycle Bin**: the bulk bar (with "Move to Trash") only
    appears when two or more rows are selected, rows have no delete action, and Delete/Backspace is only
    handled on Transfers.
27. **A Missing row in the selection makes "Move to Trash" fail for everything**: the page still counts
    the missing file as a target, `move_to_trash` is all-or-nothing, and the toast is only "Could not move
    those to the Trash". Leave Missing rows out of the targets.
28. "Trash" wording on Windows (dialog, toast, bulk button) should say **Recycle Bin**. (Add to #11.)
29. With subtitles embedded ("Inside the video"), the `.en.srt`/`.es.srt` copies are also left beside the
    video. Intended or not, the option's wording suggests one file.

### Observability

17. Pause and cancel aren't logged; only start / finish / fail are.
18. Seeding start / stop and the seed limit ending aren't logged; only the later move is.
19. Settings recovery (G1) isn't logged; only the toast shows it.

### Test plan corrections (`docs/WINDOWS-TEST-PLAN.md`)

20. C3: the toggle is under **Settings → Speed & schedule** (Queue group), not "Settings → Queue".
21. A3: needs a browser-downloaded installer; a local build never shows SmartScreen.
22. B3: note that it can only run when a newer yt-dlp exists than the bundled one.
23. C2: "File → Quit Prism (Ctrl+Q)" is macOS wording; on Windows use tray → Quit and Alt+F4.
24. F1 "correct colours / no black window" needs a person watching; the video surface can't be captured.

## Automated tests

- **Vitest** (`npm test`, default branch): 392/392 passed.
- **Playwright** (`npx playwright test`, default branch): 25/26; `extension.spec.ts` fails on Windows because
  `scripts/build-extension.mjs` shells out to `zip`, which Windows lacks.
- **Rust** (`cargo test --lib`, roadmap-complete, Rust 1.98.1 MSVC): **no tests ran.** The test binary
  `app_lib-….exe` dies at start-up with `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`. The likely cause is the
  test exe lacking the Common Controls v6 manifest the app gets from `tauri-build`, so comctl32 v5 loads
  and `TaskDialogIndirect` (used by rfd's `common-controls-v6` feature) is missing. Not yet confirmed.

25. **CI never runs the Rust tests on Windows.** `ci.yml` runs `cargo test --lib` only on `ubuntu-latest`;
    the Windows matrix job only builds. That's how #1 (a Windows-only path bug) shipped. Fix the test
    binary's manifest (e.g. embed it for test builds in `build.rs`), then add `cargo test --lib` to the
    Windows job, with a ledger round-trip test.
