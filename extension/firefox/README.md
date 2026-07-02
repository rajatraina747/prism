# Prism Downloader — Firefox extension

Sends the current page (toolbar button) or a right-clicked page/link (context
menu) to the Prism desktop app via the `prism://add?url=...` deep link. Prism
must be installed for the handoff to work; Firefox will ask to open the link
with Prism the first time (tick "remember my choice").

## Try it locally

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and pick `manifest.json` in this folder
3. The Prism icon appears in the toolbar; right-click menus are added too

Temporary add-ons unload when Firefox quits.

## Package for AMO (free)

```sh
cd extension/firefox
zip -r -FS ../prism-downloader.zip . -x '.*' -x README.md
```

Submit the zip at https://addons.mozilla.org/developers/ (free account).
Choose "On your own" (unlisted) for a signed .xpi you can distribute yourself,
or "On this site" (listed) for the public add-on store. The add-on ID is
pinned in `manifest.json` (`prism-downloader@rainacorp`), so updates must come
from the same AMO account.
