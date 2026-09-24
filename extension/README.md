# Prism Downloader: browser extension

Sends the current page (toolbar button) or a right-clicked page or link
(context menu) to the Prism desktop app through its `prism://add?url=…` deep
link. Prism must be installed. The first time, the browser asks whether to
open the link with Prism (tick "remember my choice"). Prism then shows its
confirmation card before fetching anything, as for any link from outside the
app.

It asks for one permission, `contextMenus`, and collects nothing: no network
requests of its own, no storage, no analytics.

## Layout

```
src/background.js      one script for every browser (`browser` where it exists, else `chrome`)
src/icons/             32, 64 and 128 px
manifests/base.json    everything shared, including the version
manifests/firefox.json gecko id, data-collection declaration, event-page background
manifests/chromium.json service-worker background (Chrome, Edge)
```

## Build

```sh
npm run build:extension
```

This writes `extension/dist/firefox/` and `extension/dist/chromium/`, plus a
zip of each (`prism-downloader-<browser>-<version>.zip`). Every tagged Prism
release also attaches both zips to the GitHub release. Bump the version in
`manifests/base.json`, since stores refuse an upload with a version they
already have.

## Check

- Firefox: `npx web-ext@8.10.0 lint -s extension/dist/firefox`, which is what
  AMO runs on submission. CI runs it on every push.
- Chromium: `e2e/extension.spec.ts` loads the built extension in Chromium
  and checks its service worker starts with its listeners.

## Try it locally

- **Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary
  Add-on…** → pick `extension/dist/firefox/manifest.json`. It unloads when
  Firefox quits.
- **Chrome / Edge:** `chrome://extensions` (or `edge://extensions`) → turn on
  **Developer mode** → **Load unpacked** → pick `extension/dist/chromium/`.

## Publish (free)

Both stores need an account, and submissions are manual.

- **Firefox Add-ons (AMO):** https://addons.mozilla.org/developers/ → Submit a
  New Add-on → upload `prism-downloader-firefox-<version>.zip`. "On this
  site" lists it publicly. The add-on id (`prism-downloader@rainacorp`) is
  pinned in `manifests/firefox.json`, so updates must come from the same
  account. AMO may ask for the source: it is this folder plus
  `scripts/build-extension.mjs`, and the build steps above.
- **Microsoft Edge Add-ons:** https://partner.microsoft.com/dashboard/microsoftedge
  → register (free) → create a new extension → upload
  `prism-downloader-chromium-<version>.zip`.
- **Chrome:** not on the Chrome Web Store (its $5 registration fee was
  declined). Chrome users load the Chromium zip unpacked, as above.

Both stores ask for a privacy policy URL: https://rainacorp.co.uk/prism/privacy
