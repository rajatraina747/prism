import { test, expect, type Page } from '@playwright/test';

// Under the dev-only pseudo-locale every catalog string is accented and
// bracketed (⟦Ðóŵñĺóáďš~~~⟧), so plain English left on screen is a string that
// skipped t(). User data (titles, paths, URLs) and fixed tokens are allowed.
const ALLOWED = [
  /^[\d\s.,:%/·×↑↓—–+\-()≥~…⟦⟧▾▸]*$/, // numbers, units' punctuation
  /^(B|KB|MB|GB|TB|s|m|h|p|ETA)$/,
  /^(\d+p|4K|HDR|SDR|MP3|M4A|OPUS|MKV|MP4|H\.264|HEVC|AV1|VP9)$/i,
  /youtube|https?:|~\/|\/Users\//i,
  /Lucifer|BluRay|x265|magnet:|torrent$|\[[0-9a-f:.]+\]|^[\w.-]+\/[\d.]+/i, // seeded user data, peer addresses, client ids
  /\.(iso|txt|mkv|mp4)$|^udp:|^(tcp|utp)$|\d{4}, \d{1,2}:\d{2}|^\d{1,2} \w{3} \d{4}|^\w{3} \d{1,2}, \d{4}/i, // file names, transports, OS-formatted dates
  /^(qBittorrent|Transmission|libtorrent|Deluge|rqbit|µTorrent) [\d.]+$/, // peer clients
  /^(yt-dlp|ffmpeg|Prism|RainaCorp|rainacorp\.co\.uk|DHT|uTP|UPnP|LSD|PEX|SponsorBlock|IPv4|IPv6|socks5h?|qBittorrent|Transmission|Safari|Chrome|Firefox|Edge|Brave)$/,
];

async function untranslated(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || el.closest('[data-user-content], script, style, svg, input, textarea, select option[value=""]')) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const text = (n.textContent ?? '').trim();
      if (!text || text.includes('⟦') || text.includes('⟧')) continue;
      if (!/[A-Za-z]{2}/.test(text)) continue;
      out.add(text);
    }
    return [...out];
  });
}

const TORRENT = { id: 't1', kind: 'torrent', metadata: { title: 'Lucifer (2016) S01-S06 (1080p BluRay x265)', duration: 0, thumbnail: '', source: { url: 'magnet:?xt=urn:btih:' + 'a'.repeat(40), domain: 'torrent', addedAt: '2026-11-01T10:00:00Z' }, formats: [] },
  settings: { format: null, destination: '~/Downloads/Prism', filename: 'x', startImmediately: true }, status: 'downloading', progress: 80.3, speed: 1782579, uploadSpeed: 193000, eta: 3180, downloadedBytes: 20800000000, totalBytes: 26000000000, retryAttempt: 0, peers: 13, peersSeen: 768, ratio: 0.004, uploadedBytes: 1000 };

const ROUTES = ['/', '/subscriptions', '/library', '/settings', '/about'];

test('pseudo-locale: no hard-coded English on the main screens', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('prism_locale', 'pseudo');
    localStorage.setItem('prism_splash_seen', '1');
  });
  const found: Record<string, string[]> = {};
  for (const route of ROUTES) {
    await page.goto(route);
    await page.waitForTimeout(400);
    const left = (await untranslated(page)).filter(s => !ALLOWED.some(re => re.test(s)));
    if (left.length) found[route] = left;
  }
  // A running torrent, its row and every tab of its detail panel.
  await page.addInitScript((q) => {
    localStorage.setItem('prism_queue', JSON.stringify(q));
    localStorage.setItem('prism_settings', JSON.stringify({ setupCardDismissed: true, clipboardWatchEnabled: false }));
  }, [TORRENT]);
  await page.goto('/');
  await page.locator('[aria-label*="Lucifer"]').first().dblclick();
  const detailTabs = page.getByRole('tablist').last().getByRole('tab');
  await expect(detailTabs).toHaveCount(5);
  for (const [i, tab] of ['general', 'files', 'peers', 'trackers', 'speed'].entries()) {
    await detailTabs.nth(i).click();
    await page.waitForTimeout(250);
    const left = (await untranslated(page)).filter(s => !ALLOWED.some(re => re.test(s)));
    if (left.length) found[`/ details:${tab}`] = left;
  }
  for (const tab of ['downloads', 'torrents', 'network', 'privacy']) {
    await page.goto(`/settings?tab=${tab}`);
    await page.waitForTimeout(300);
    const left = (await untranslated(page)).filter(s => !ALLOWED.some(re => re.test(s)));
    if (left.length) found[`/settings?tab=${tab}`] = left;
  }
  expect(found).toEqual({});
});
