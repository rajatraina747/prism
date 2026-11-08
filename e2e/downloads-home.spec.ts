import { test, expect, type Page } from '@playwright/test';

const finished = (n: number) => ({
  id: `done-${n}`,
  metadata: { title: `Finished ${n}`, duration: 60, source: { url: `https://example.com/${n}`, domain: 'example.com', addedAt: '2026-11-01T10:00:00Z' }, formats: [] },
  settings: { format: { id: 'x', label: '1080p', resolution: '1080p', container: 'mp4', codec: 'h264', fileSize: 1_000_000_000, quality: 'high' }, destination: '~/Downloads/Prism', filename: `f${n}`, retryCount: 3, startImmediately: false },
  status: 'completed',
  completedAt: '2026-11-01T11:00:00Z',
  fileSize: 1_000_000_000,
});

const paused = (n: number) => ({
  ...finished(n),
  id: `active-${n}`,
  metadata: { ...finished(n).metadata, title: `Active ${n}` },
  status: 'paused',
  completedAt: undefined,
  fileSize: undefined,
  totalBytes: 1_000_000_000,
  progress: 10,
  downloadedBytes: 100_000_000,
  speed: 0,
  eta: 0,
  retryAttempt: 0,
});

async function seed(page: Page, queueLength: number) {
  await page.addInitScript(({ history, queue }) => {
    localStorage.setItem('prism_splash_seen', '1');
    localStorage.setItem('prism_history', JSON.stringify(history));
    localStorage.setItem('prism_queue', JSON.stringify(queue));
    localStorage.setItem('prism_settings', JSON.stringify({ setupCardDismissed: true, clipboardWatchEnabled: false }));
  }, {
    history: [1, 2, 3, 4].map(finished),
    queue: Array.from({ length: queueLength }, (_, i) => paused(i + 1)),
  });
  await page.goto('/');
}

test.describe('Downloads home', () => {
  test('an idle page shows the totals and recent downloads', async ({ page }) => {
    await seed(page, 0);
    await expect(page.getByText('Total downloaded')).toBeVisible();
    await expect(page.getByText('Recent Downloads')).toBeVisible();
    await expect(page.getByText('Finished 3')).toBeVisible();
    await expect(page.getByText('Finished 4')).toBeHidden();
    await expect(page.getByText('Nothing downloading')).toBeHidden();
  });

  test('recent downloads give way once the queue is long', async ({ page }) => {
    await seed(page, 4);
    await expect(page.getByText('Active 4')).toBeVisible();
    await expect(page.getByText('Recent Downloads')).toBeHidden();
    await expect(page.getByText('Total downloaded')).toBeVisible();
  });

  test('a first run still explains the empty page', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('prism_splash_seen', '1'));
    await page.goto('/');
    await expect(page.getByText('Nothing downloading')).toBeVisible();
    await expect(page.getByText('Recent Downloads')).toBeHidden();
  });
});
