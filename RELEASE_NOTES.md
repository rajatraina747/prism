<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->

## What's New

Convert to MP4 (H.264) and MP4 (HEVC) work again in the downloaded app.

### Fixes

- **Converting to MP4 H.264 / HEVC no longer fails.** Prism ships an LGPL
  build of ffmpeg, which can't include the x264/x265 encoders those presets
  asked for, so every such conversion stopped with an error. Prism now uses
  the encoder your computer actually has: Apple's hardware encoder on a Mac,
  your NVIDIA/Intel/AMD GPU or Windows' built-in encoder on Windows, and the
  OpenH264/Kvazaar software encoders otherwise. It tries each one on a split
  second of video first, so a GPU encoder that's listed but unusable is
  skipped rather than failing your conversion. The same applies to the
  automatic "make it play in QuickTime" re-encode added in 2.3.5, which
  until now could only re-encode video on a Mac.
