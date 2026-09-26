# Windows test plan: the 2.3 roadmap build

For hands-on testing on the Windows PC (AMD, x64) before 2.3.0 is released.
The code is tag `roadmap-complete`: the 2.3 roadmap in `ROADMAP.md`, from
the 2026-09-26 review. It is **not a release**: nothing here is signed or
published, and 2.3.0 ships only after this plan passes.

CI already compiles and lints the Windows build on every push, but it doesn't
run the app. Everything below is what only a real Windows machine can show.

## 1. One-time setup

Install, in this order:

1. **Git for Windows** (it brings Git Bash, which the fetch script needs).
2. **7-Zip**, with its folder (`C:\Program Files\7-Zip`) added to `PATH`: the
   player libraries arrive as a `.7z`.
3. **Node.js 20 or newer** (CI uses 20; 24 works).
4. **Rust** via `rustup` with the MSVC toolchain, plus **Visual Studio Build
   Tools** ("Desktop development with C++").
5. **WebView2**: already on Windows 11; on Windows 10, install the Evergreen
   runtime.

## 2. Get the code and build it

In Git Bash:

```bash
git clone git@github.com:rajatraina747/prism.git
cd prism
git checkout roadmap-complete
npm ci
bash scripts/fetch-sidecars.sh windows --player   # yt-dlp (onedir), Deno, libmpv, ffmpeg — all SHA-256-checked
```

- **Try it quickly:** `npm run dev:tauri`
- **Build the installer:** `npm run build:tauri`. The NSIS installer lands in
  `src-tauri\target\release\bundle\nsis\`.

The updater's signing key isn't on this PC. If the build stops asking for
`TAURI_SIGNING_PRIVATE_KEY`, build without updater artifacts:

```bash
npx tauri build --config "{\"bundle\":{\"createUpdaterArtifacts\":false}}"
```

## 3. Keep test data apart from real data

Two ways to run it:

- **Dev runs** (`npm run dev:tauri`) use the real app-data folder. To keep them
  separate:

  ```bash
  npx tauri dev --config "{\"identifier\":\"com.rainacorp.prism.dev\"}"
  ```

- **The upgrade test (A1)** is the one place to use the real identifier: install
  2.2.1 first, add a few things, then install the new build over it.

Where things live (real identifier; the dev one uses
`com.rainacorp.prism.dev`):

| What | Where |
|---|---|
| Data (queue, Library, settings) | `%APPDATA%\com.rainacorp.prism\` (`prism.db` from 2.3; the old JSON files stay beside it) |
| Log | `%LOCALAPPDATA%\com.rainacorp.prism\logs\Prism.log` |
| Engine | `ytdlp\yt-dlp.exe` beside `Prism.exe` in the install folder |

## 4. What to check

Tick each row. When one fails, note its ID, what happened, and the lines
around it in `Prism.log`.

### A. Install and upgrade

| ID | Do | Expect |
|---|---|---|
| A1 | Install 2.2.1. Add two items to the queue and complete one download. Then install this build over it. | Queue and Library intact. `prism.db` created in the data folder; `queue.json`/`history.json` still there, untouched. The log says "copied the JSON data into prism.db". |
| A2 | Launch after the upgrade. | Nothing downloads again that had finished. |
| A3 | SmartScreen at first launch (unsigned build). | "More info → Run anyway" works; nothing else blocks. |

### B. The engine (Phase 3)

| ID | Do | Expect |
|---|---|---|
| B1 | Paste a YouTube link. | The details dialog appears in a few seconds. The first run after install may take longer while Defender scans the engine folder; later ones should be quick. |
| B2 | Pause and cancel a few video downloads, then look in `%TEMP%`. | No new `_MEI…` folders appear: the onedir engine doesn't unpack anything. |
| B3 | Settings → Updates → update the engine (if a newer yt-dlp exists). | It installs; downloads still work. Update again while a download runs: it may refuse with "The engine is in use" and must leave the current engine working. |

### C. Window, tray, quit (Phase 1)

| ID | Do | Expect |
|---|---|---|
| C1 | Start a download, then close the window with ✕. | The window hides, a "Prism is still running" notification appears once, and the download carries on. Open Prism again from the tray. |
| C2 | With the download running: tray → Quit, and File → Quit Prism (Ctrl+Q). | A "Quit Prism?" dialog. "Keep running" keeps it; "Quit" quits. |
| C3 | Turn off Settings → Queue → "Keep running when the window is closed", then close the window with a download running. | The quit question appears instead of hiding. |
| C4 | Nothing running → quit. | Quits straight away. |

### D. Downloads and the queue (Phases 2, 4, 5, 6)

| ID | Do | Expect |
|---|---|---|
| D1 | A single video; a playlist URL; a channel (`/@name`); a watch URL from a Mix (`list=RD…`). | Video → details dialog. Playlist and channel → list dialog (the channel shows its Videos). Mix → just that video. |
| D2 | Paste several links at once (Add sheet), including a playlist. | All queue in pasted order; the playlist's entries are all added. |
| D3 | 4K video details dialog. | Labels like "2160p60 · VP9", "1080p60 · H.264", HDR only from 1080p; a note under VP9/AV1 choices. |
| D4 | A dubbed video (many MrBeast uploads). | "Audio" picker lists the tracks, original first; a chosen dub is what downloads. |
| D5 | Subtitles: pick two languages, tick "Inside the video". | One file with both subtitle tracks (check in VLC). |
| D6 | Close Prism with ✕ (hidden) while a queue of 3+ downloads runs. | They finish one after another with the window hidden; they're in the Library afterwards. |
| D7 | Kill Prism in Task Manager mid-download, then relaunch. | The item comes back queued and resumes; the finished file plays. |
| D8 | Add three magnets with no peers and a YouTube video. | The video starts even though the torrents hold their slots (torrents have their own limit). |
| D9 | A well-seeded torrent (e.g. a Debian netinst ISO) with seeding on. | When the download finishes it appears in the Library tagged **Seeding** while Transfers still shows it seeding; when seeding ends, the tag goes and the file (moved, if "Move completed" is on) opens. |
| D10 | Direct file link (e.g. `https://fsn1-speed.hetzner.com/100MB.bin`). | Downloads over several connections; pausing and resuming continues from where it was. |
| D11 | Set a SOCKS proxy (`socks5h://…`), then add a direct link. | It downloads through the proxy; before 2.3 this failed outright. |
| D12 | Set qBittorrent's listening port to 4240 (Prism's), leave it running, then add a torrent in Prism. | Prism's torrents still work: the log shows it fell back to another port. |
| D13 | Settings → BitTorrent → change the listen port → "Restart engine" while a torrent runs. | It pauses briefly and carries on without re-checking its files. |

### E. Files and paths (Windows-specific)

| ID | Do | Expect |
|---|---|---|
| E1 | A video whose title has `: ? * " < > \|`. | Downloads; Play and Show in Folder work (yt-dlp renames those characters on Windows). |
| E2 | A download folder deep enough that paths pass 260 characters. | Works, or fails with a clear message rather than silently. |
| E3 | Downloads folder redirected to OneDrive. | Downloads land there; Show in Folder opens Explorer on the file. |
| E4 | Right-click a finished download → Properties. | "This file came from another computer" (Mark of the Web) on video and torrent files. |
| E5 | Delete a finished file in Explorer, then open the Library. | Its row shows **Missing**. |
| E6 | Double-click a `.torrent` file; open a `magnet:` link in a browser; open `prism://add?url=…`. | Each reaches Prism's confirmation card. |

### F. Player (AMD graphics)

| ID | Do | Expect |
|---|---|---|
| F1 | Play a finished 1080p and a 4K file in Prism's player. | Smooth playback, correct colours, seeking works, and no black window. |
| F2 | Torrent "Play now" while it downloads. | Starts after a short buffer; seeking fetches the right pieces. |

### G. Settings, recovery, when-done

| ID | Do | Expect |
|---|---|---|
| G1 | Quit Prism, then corrupt `settings.json` (type rubbish into it). Relaunch. | A toast says settings were restored from a backup; the damaged file is kept as `settings.corrupt-….json`. |
| G2 | Quit Prism, then rename `prism.db` to something unreadable (e.g. write text into a copy and put it in place). Relaunch. | A toast about the queue and Library; the damaged file kept as `prism.corrupt-….db`. |
| G3 | Direct downloads with Settings → Network → "Identify as a browser" on, then off. | Both work on ordinary servers. |
| G4 | "When everything finishes" = **Sleep**, with one short download. | After it finishes, a 60-second countdown toast with Cancel; Cancel stops it. Let it run once and the PC sleeps. Try **Shut down** last, and only if you're happy for the PC to switch off. |
| G5 | Taskbar icon while downloading. | A progress bar on the taskbar button; paused shows yellow. |

## 5. After testing

- **Every row passes:** say so. Rajat approves the release build, which follows
  the usual checklist: version bump, tag `v2.3.0`, and the `release`
  environment.
- **Something fails:** the fix lands on `roadmap/2.3` as its own commit and this
  plan is re-run for that area. Any earlier state is `git checkout roadmap-pN`
  (phases 1–6) or `roadmap-base` (before the roadmap).
