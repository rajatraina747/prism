<!--
Release notes for the NEXT tagged release. Edit this BEFORE tagging — the
Build & Release workflow reads it verbatim as the GitHub release body and the
in-app updater notes. This comment block is invisible in rendered markdown.
-->

## What's New

Hardening and speed, continuing from the review behind 2.3.1.

### Safer

- **Cancelling a paused or stopped torrent now removes what it downloaded**,
  as cancelling a running one always did. It never touches a download that
  already finished.
- **Undo after Cancel resumes the download where it stopped.** Before, the
  download started again from nothing.
- **A pause pressed just as a download starts now takes effect.** Before, the
  download could carry on regardless, and resuming it made a second copy.
- **Direct downloads survive a crash or power cut without damage.** Resuming
  never keeps parts of the file that were never written to disk.
- A download that restarts after failing on a server without resume support
  reuses its partial file instead of leaving it behind.
- Prism no longer keeps what you copy to the clipboard, only a fingerprint
  that tells a link it has already seen.
- With a proxy set, DHT and uTP are turned off, because they can't go
  through it and would show peers your real address. Settings says so.
- A proxy password is no longer visible to other programs on the computer,
  or written to the log.
- A global shortcut now needs Ctrl, Alt or Cmd, so it can't take an
  ordinary key away from every other app.
- On Windows, Prism no longer looks at network paths it was handed unless
  they are inside a folder you chose.

### Faster

- **The queue is saved far more cheaply:** only what changed is written,
  rather than the whole list every two seconds.
- **Large torrents no longer slow the window down:** their file lists are
  sent to the window only when they change.
- **Transfers stays smooth with many downloads:** rows redraw only when their
  own download changes.
- **Pages open on demand, and launch no longer waits on the database
  backup.**
- **Editing Settings no longer makes every subscription check itself 15
  seconds later.**

### Fixes

- Settings fields that something acts on (category sites, shortcuts, clip
  times) take effect when you leave the field or press Enter. Typed commas
  in a category's sites no longer disappear.
- The link confirmation shows which page a link came from.
- The details panel can be resized with the keyboard, and resizing it no
  longer saves the setting on every mouse movement.
- Names too long for the disk (such as long Japanese titles), and Windows'
  reserved names such as CON, are handled.
