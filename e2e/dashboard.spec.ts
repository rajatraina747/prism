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
});
