<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->
## What's New

**Updates work again on networks that block part of GitHub.** If Settings said
"Could not reach update server" while GitHub worked fine in your browser, the
updater was stuck waiting on one unreachable GitHub server. It never tried the
others. It now moves on after a few seconds, and Settings shows the real error
if a check does fail. *Earlier versions have the bug, so download this release
yourself* (`brew upgrade --cask prism`, or the files below). Later updates
install from inside Prism again.

**One place to add anything.** An **Add** button sits at the top of the
sidebar, and ⌘N or ⌘L opens it from any page. Paste video links and magnet
links, open a `.torrent`, or import a list. You can also drop links, `.torrent`
files or a text file of links anywhere in the window.

**Links from outside Prism ask first.** A `magnet:` or `prism://` link opened
from a browser, or a `.torrent` opened from Finder or Explorer, now shows what
it is and waits for **Add**. Nothing is fetched until you choose to. Pasting,
the Add sheet and drag-and-drop still add straight away.

**Failures tell you what to do.** A failed transfer shows the likely cause,
the engine's own message on one line, and the fix. That's **Set browser
cookies** for sign-in walls, or **Retry**. Link errors under the URL box and
failed items in the Library work the same way.

**Settings, reorganised.** Settings are now grouped into Video, BitTorrent,
Speed & schedule and Network. Rarely used torrent engine options sit behind
"Show advanced settings". All three speed limits use MB/s. Terms like DHT,
uTP, UPnP and share ratio are explained where they appear. New: **Use IPv4
only** (on by default, as before).

**Quiet hours you can see.** A banner on the Dashboard and Transfers says when
quiet hours end, and whether downloads are held or slowed. Held transfers say
"Held for quiet hours" instead of "Waiting for a slot".

**Big libraries stay fast.** The Library and the torrent and playlist pickers
only draw the rows on screen, so thousands of entries scroll smoothly.

**Accessibility.** Every setting is labelled for screen readers. The Transfers
list works as a proper list with the keyboard, filter tabs are real tabs, and
Reduce Motion is respected. Moving a row with its handle no longer also moves
the selection.

**Security hardening** from the September review:
- Prism's window can only write its own settings, queue and history files.
  The torrent session, cached `.torrent` files and the self-updated downloader
  are out of its reach.
- A self-updated yt-dlp is checked against the checksum recorded when it was
  installed. *If you updated the engine in an earlier version, Prism uses the
  bundled yt-dlp until you press **Update Engine** once more.*
- Windows: the player loads its libraries only from Prism's own folder.
- Limits on how many yt-dlp processes run at once and how much output Prism
  keeps in memory.
- System folders are blocked regardless of letter case on macOS and Windows.
  On Linux, `~/bin` and launchers on the Desktop are blocked too.
- Updated rustls for RUSTSEC-2026-0285.

**Also:** a **Report a bug** link in About, clearer backend logs, and a smaller
app: the logos went from 7 MB to under 100 KB, and unused interface code was
removed.

## Install

- **macOS:** `brew install --cask rajatraina747/prism/prism` (or `brew upgrade --cask prism`), or download the
  `.dmg`. Not notarized: on macOS 15+ open the app once, then System Settings →
  Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/Prism.app`).
- **Windows:** run the installer; click "More info → Run anyway" on the SmartScreen prompt.
- **Linux:** AppImage, `.deb` or `.rpm`.
