import { test, expect, type Page } from '@playwright/test';

const channel = {
  id: 'c1',
  url: 'https://www.youtube.com/@talks',
  title: 'Talks Channel',
  type: 'channel',
  addedAt: '2026-11-01T10:00:00Z',
  enabled: true,
  audioOnly: false,
  seenUrls: [],
};

async function seed(page: Page, categories: unknown[] = []) {
  await page.addInitScript(({ channel, categories }) => {
    localStorage.setItem('prism_splash_seen', '1');
    localStorage.setItem('prism_subscriptions', JSON.stringify([channel]));
    localStorage.setItem('prism_settings', JSON.stringify({ setupCardDismissed: true, clipboardWatchEnabled: false, categories }));
  }, { channel, categories });
  await page.goto('/subscriptions');
}

test.describe('Subscription options', () => {
  test('quality and category are saved and shown on the row', async ({ page }) => {
    await seed(page, [{ id: 'talks', name: 'Lectures', destination: '/media/lectures', filenameTemplate: '', domains: [], kinds: [] }]);
    await page.getByRole('button', { name: 'Download options' }).click();

    await page.getByLabel('Quality').selectOption('720p');
    await page.getByLabel('Category').selectOption('talks');

    await expect(page.locator('span', { hasText: /^720p$/ })).toBeVisible();
    await expect(page.locator('span', { hasText: /^Lectures$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /media\/lectures/ })).toBeVisible();

    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('prism_subscriptions') ?? '[]')[0]))
      .toMatchObject({ quality: '720p', categoryId: 'talks' });
  });

  test('audio-only has no quality to choose', async ({ page }) => {
    await seed(page);
    await page.getByRole('button', { name: 'Switch to audio-only downloads' }).click();
    await page.getByRole('button', { name: 'Download options' }).click();
    await expect(page.getByLabel('Quality')).toHaveCount(0);
  });

  test('a disabled button says why', async ({ page }) => {
    await seed(page);
    await page.getByRole('button', { name: 'Subscribe', exact: true }).hover({ force: true });
    await expect(page.getByRole('tooltip')).toHaveText('Paste a feed link first');
  });
});
