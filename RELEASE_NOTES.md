<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->

## What's New

Videos from Instagram, Facebook and similar sites now play in QuickTime, iMessage and on iPhone/iPad.

### Fixes

- **Downloads that QuickTime couldn't open now can.** Many sites serve VP9/AV1
  video or Opus audio, which Prism wrapped in an `.mp4` without changing, so
  QuickTime refused it, iMessage wouldn't preview it and AirDrop to an iPhone
  or iPad arrived as a plain file. After a download Prism now re-encodes just
  the streams Apple players can't decode (to H.264 / AAC); everything else is
  copied untouched, so ordinary YouTube downloads take no extra time. If the
  conversion fails, the original file is kept. Turn on "Keep original
  container" in Settings to skip this.
