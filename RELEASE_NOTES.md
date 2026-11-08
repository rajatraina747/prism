<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->

## What's New

### Security

- **Public links stay on the public internet.** A direct download, feed or
  thumbnail can no longer be redirected to your computer or other devices on
  your network by a remote server. Links you give Prism that use a local
  address, such as a NAS, keep working.

### Under the hood

- The app updater and the Tauri framework are up to date.
- Starting a direct download no longer does its disk checks on the network
  threads.
