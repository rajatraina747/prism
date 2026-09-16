# Security policy

## Supported versions

Only the latest release gets security fixes. Prism updates itself: check
**Settings → Updates**, or download the newest build from
[Releases](https://github.com/rajatraina747/prism/releases/latest).

## Reporting a vulnerability

Please **don't open a public issue** for a security problem.

Report it privately through GitHub instead:
**[Report a vulnerability](https://github.com/rajatraina747/prism/security/advisories/new)**.

Please include:

- the Prism version (Settings → About) and your OS
- what an attacker can do, and what they need first (for example a malicious
  web page, a crafted `.torrent` or magnet link, or local access)
- steps to reproduce, or a proof of concept
- whether you'd like to be credited in the release notes

You'll get an acknowledgement within a week. Fixes for confirmed issues ship
in a release as soon as they're ready, and the advisory is published once
users have had a chance to update.

## Scope

In scope: the Prism app and its Rust backend, the permissions granted to its
web view, the update and signing pipeline (`.github/workflows/build.yml`,
[`docs/RELEASE-KEYS.md`](docs/RELEASE-KEYS.md)), and how Prism runs its bundled
engines and handles files.

Two surfaces worth naming explicitly, since both are reachable without the user
doing anything:

- The loopback stream server that feeds the player while a torrent is still
  downloading — bound to `127.0.0.1` on a random port, with a 32-byte token
  minted per launch, a constant-time token check and a `Host` check.
- Optional system-wide hotkeys. They are registered in Rust and default to
  none; the web view is never granted permission to bind keys itself.

Report these upstream instead, unless Prism makes the problem worse:
[yt-dlp](https://github.com/yt-dlp/yt-dlp/security),
[librqbit](https://github.com/ikatson/rqbit), [mpv](https://github.com/mpv-player/mpv),
and [Tauri](https://github.com/tauri-apps/tauri/security).

Security reviews of Prism so far are in [`docs/`](docs/).
