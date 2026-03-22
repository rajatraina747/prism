# Prism

Premium video downloader — a desktop application built with Tauri, React, and TypeScript.

## Features

- Paste single or multiple video URLs to download
- Multi-format quality selection (4K, 1080p, 720p, 480p)
- Download queue with pause, resume, cancel, retry, and drag-to-reorder
- Download history with search and filtering
- Configurable concurrent downloads and bandwidth limits
- Clipboard auto-detect for video URLs
- Dark and light theme support
- Local-first data persistence

## Tech Stack

- **Frontend:** React 18, TypeScript, Tailwind CSS, shadcn/ui
- **Desktop:** Tauri v2 (Rust backend)
- **Download Engine:** yt-dlp (bundled as sidecar)
- **Build:** Vite 5

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

# Production build (web)
npm run build

# Production build (desktop)
npm run build:tauri
```

## Project Structure

```
src/
├── components/       # React components (layout, dashboard, queue, common, ui)
├── hooks/            # Custom React hooks
├── pages/            # Route page components
├── services/         # Service abstraction layer (mock + Tauri implementations)
├── stores/           # React Context providers (Queue, History, Settings)
├── types/            # TypeScript type definitions
└── test/             # Test setup and utilities
src-tauri/            # Tauri/Rust backend (desktop app)
```
