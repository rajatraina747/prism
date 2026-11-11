import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test('shows URL input', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByPlaceholder(/Paste a video URL/i)).toBeVisible();
  });

  test('Fetch button is disabled when input is empty', async ({ page }) => {
    await page.goto('/');
    const fetchBtn = page.getByRole('button', { name: 'Fetch' });
    await expect(fetchBtn).toBeDisabled();
  });

  test('Fetch button enables when URL is typed', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder(/Paste a video URL/i).fill('https://youtube.com/watch?v=test');
    const fetchBtn = page.getByRole('button', { name: 'Fetch' });
    await expect(fetchBtn).toBeEnabled();
  });

  test('submitting a URL shows the media details modal', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder(/Paste a video URL/i).fill('https://youtube.com/watch?v=test');
    await page.getByRole('button', { name: 'Fetch' }).click();

    // Wait for the mock service to parse (800-2000ms)
    await expect(page.getByText(/Add to Queue/i)).toBeVisible({ timeout: 5000 });
  });

  test('audio only offers the audio quality, with the source and what a choice does', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('prism_splash_seen', '1'));
    await page.goto('/');
    await page.getByPlaceholder(/Paste a video URL/i).fill('https://youtube.com/watch?v=audio');
    await page.getByRole('button', { name: 'Fetch' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Audio only' }).click({ timeout: 5000 });

    const select = dialog.getByLabel('Audio quality');
    await expect(select).toHaveValue('mp3-v0');
    await expect(dialog.getByText('Source: Opus 141 kbps')).toBeVisible();
    await select.selectOption('mp3-320');
    await expect(dialog.getByText('Bigger file, same sound: the source is only 141 kbps.')).toBeVisible();
    await select.selectOption('original');
    await expect(dialog.getByText(/Keeps the site's own audio/)).toBeVisible();

    await dialog.getByRole('button', { name: /Add to queue/i }).click();
    const items = await page.evaluate(() => JSON.parse(localStorage.getItem('prism_queue') ?? '[]'));
    expect(items.at(-1).settings).toMatchObject({ audioOnly: true, audioQuality: 'original' });
  });
});
