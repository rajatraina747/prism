<p align="center">
  <img src="public/logo-nobg.png" alt="Prism" width="120" />
</p>

<h1 align="center">Prism</h1>

<p align="center">
  <strong>Premium video downloader for macOS and Windows</strong><br/>
  Download from YouTube, Instagram, TikTok, and 1000+ sites — powered by yt-dlp.<br/>
  <em>by RainaCorp</em>
</p>

<p align="center">
  <a href="https://github.com/rajatraina747/video-vault-pro/actions/workflows/ci.yml"><img src="https://github.com/rajatraina747/video-vault-pro/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/rajatraina747/video-vault-pro/releases/latest"><img src="https://img.shields.io/github/v/release/rajatraina747/video-vault-pro?label=latest" alt="Latest Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/rajatraina747/video-vault-pro" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue" alt="Platform" />
</p>

---

<p align="center">
  <img src="docs/screenshots/app-light.png" alt="Prism Screenshot" width="800" />
</p>

## Features

- **Multi-format quality selection** — Choose between 4K, 1080p, 720p, or 480p. H.264/AAC for native QuickTime playback.
- **Download queue** — Pause, resume, cancel, retry, and drag-to-reorder. Configurable concurrent downloads and bandwidth limits.
- **Batch downloads** — Paste multiple URLs at once or import entire playlists with per-video selection.
- **Download history** — Searchable log of every download with one-click replay.
- **Clipboard auto-detect** — Automatically detects video URLs copied to your clipboard.
- **Dark and light themes** — Follows your system preference or set manually.
- **Cross-platform** — Native desktop apps for macOS (Apple Silicon + Intel) and Windows.
- **Privacy-first** — All data stays on your machine. No accounts, no telemetry, no tracking.

## Download

Get the latest release for your platform:

| Platform | Download |
|----------|----------|
| macOS | [Prism.dmg](https://github.com/rajatraina747/video-vault-pro/releases/latest) |
| Windows | [Prism-setup.exe](https://github.com/rajatraina747/video-vault-pro/releases/latest) |
| Web Demo | [Try in your browser](https://rajatraina747.github.io/video-vault-pro/) |

> **macOS note:** If macOS warns about an unidentified developer, right-click the app and choose "Open".
> **Windows note:** Windows may show a SmartScreen warning — click "More info" then "Run anyway".

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Tailwind CSS, shadcn/ui |
| Desktop | Tauri v2 (Rust backend) |
| Download Engine | yt-dlp + Deno (bundled as sidecars) |
| Build | Vite 5 |

## Development

```bash
# Install dependencies
npm install

# Start web dev server (mock downloads)
npm run dev

# Start Tauri desktop app
npm run dev:tauri

# Run tests
npm test

# Production build (desktop)
npm run build:tauri
```

## Project Structure

```
src/
├── components/     # React components (layout, dashboard, queue, media-details)
├── hooks/          # Custom React hooks
├── pages/          # Route page components (Dashboard, Settings, History, About)
├── services/       # Service abstraction layer (mock + Tauri implementations)
├── stores/         # React Context providers (Queue, History, Settings)
├── types/          # TypeScript type definitions
└── test/           # Test setup and utilities

src-tauri/
├── src/            # Rust backend (commands, download manager)
├── binaries/       # Bundled sidecars (yt-dlp, deno)
└── icons/          # App icons (macOS, Windows, iOS, Android)
```

## License

[MIT](LICENSE) — Copyright 2025-2026 RainaCorp

---

<p align="center">
  Built with care by <strong>RainaCorp</strong>
</p>
