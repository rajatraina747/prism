import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, chromium } from '@playwright/test';

// The Chromium build of the Prism Downloader extension (Edge Add-ons, and
// Chrome as an unpacked extension) must load, and its one shared background
// script must run as a service worker. The Firefox build is checked by
// `web-ext lint` in CI.
test('the Chromium extension build loads and its service worker starts', async () => {
  execFileSync('node', ['scripts/build-extension.mjs']);
  const extension = join(process.cwd(), 'extension', 'dist', 'chromium');
  const profile = mkdtempSync(join(tmpdir(), 'prism-ext-'));
  // Full Chromium, not the headless shell: only it loads extensions.
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    expect(worker.url()).toMatch(/^chrome-extension:\/\/[a-z]+\/background\.js$/);
    // The script ran: `api` resolved to `chrome`, and its listeners exist.
    const ready = await worker.evaluate(() => typeof chrome.contextMenus.onClicked.hasListeners === 'function'
      && chrome.contextMenus.onClicked.hasListeners()
      && chrome.action.onClicked.hasListeners());
    expect(ready).toBe(true);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
