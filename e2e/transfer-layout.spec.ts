import { test, expect } from '@playwright/test';
const item = (id: string) => ({ id, kind: 'torrent', metadata: { title: 'Lucifer (2016) Season 1-6 S01-S06 + Extras (1080p BluRay x265 HEVC 10bit EAC3 5.1)', duration: 0, thumbnail: '', source: { url: 'magnet:?xt=urn:btih:' + 'a'.repeat(40), domain: 'torrent', addedAt: '2026-11-01T10:00:00Z' }, formats: [] },
  settings: { format: null, destination: '~/Downloads/Prism', filename: 'x', startImmediately: true }, status: 'downloading', progress: 80.3, speed: 1782579, uploadSpeed: 193000, eta: 3180, downloadedBytes: 20800000000, totalBytes: 26000000000, retryAttempt: 0, peers: 13, peersSeen: 768, ratio: 0.004, uploadedBytes: 1000 });
// Real values from a 26 GB torrent: the stats row wrapped as its speed changed,
// and long IPv6-mapped peer addresses pushed the table past the panel.
for (const w of [1500, 900]) test('transfer row and peers table fit at ' + w, async ({ page }) => {
  await page.setViewportSize({ width: w, height: 800 });
  await page.addInitScript((q) => { localStorage.setItem('prism_splash_seen', '1'); localStorage.setItem('prism_queue', JSON.stringify(q)); localStorage.setItem('prism_settings', JSON.stringify({ setupCardDismissed: true, clipboardWatchEnabled: false })); }, [item('t1')]);
  await page.goto('/');
  const row = page.locator('[aria-label^="Lucifer"]').first();
  await expect(row).toBeVisible();
  const statsH = await page.locator('div.tabular-nums', { hasText: 'ETA' }).first().evaluate(e => e.getBoundingClientRect().height);
  expect(statsH).toBeLessThanOrEqual(16.5);
  await row.dblclick();
  await page.getByRole('tab', { name: 'Peers' }).click();
  await page.locator('table td').first().waitFor();
  await page.evaluate(() => { document.querySelectorAll('table tbody tr').forEach(tr => { (tr.children[0] as HTMLElement).textContent = '[2001:0db8:85a3:0000:0000:8a2e:0370:7334]:54208'; (tr.children[1] as HTMLElement).textContent = 'Deluge/2.2.0 libtorrent/1.2.19.0 with a long name'; (tr.children[3] as HTMLElement).textContent = 'live (1 err)'; (tr.children[4] as HTMLElement).textContent = '559.3 KB/s'; }); });
  const m = await page.locator('table').first().evaluate(t => { const v = t.closest('[data-radix-scroll-area-viewport]') as HTMLElement; const tr = t.querySelector('tbody tr') as HTMLElement; return { table: t.getBoundingClientRect().width, view: v.clientWidth, sw: v.scrollWidth, row: tr.getBoundingClientRect().height }; });
  expect(m.sw).toBeLessThanOrEqual(m.view);
  expect(m.row).toBeLessThan(30);
});
