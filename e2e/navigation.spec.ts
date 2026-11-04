import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  test('opens on Downloads, with the link box', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('Downloads');
    await expect(page.getByPlaceholder(/Paste a video URL/i)).toBeVisible();
  });

  test('navigates back to Downloads', async ({ page }) => {
    await page.goto('/library');
    await page.click('a[href="/"]');
    await expect(page.locator('h1')).toContainText('Downloads');
  });

  test('the old Transfers address opens Downloads', async ({ page }) => {
    await page.goto('/queue');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('h1')).toContainText('Downloads');
  });

  test('navigates to Library page', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/library"]');
    await expect(page.locator('h1')).toContainText('Library');
  });

  test('old routes redirect to Library', async ({ page }) => {
    for (const old of ['/downloads', '/failed', '/history']) {
      await page.goto(old);
      await expect(page.locator('h1')).toContainText('Library');
    }
  });

  test('navigates to Settings page', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/settings"]');
    await expect(page.locator('h1')).toContainText('Settings');
  });

  test('reaches About from Settings', async ({ page }) => {
    await page.goto('/settings?section=privacy');
    await page.getByRole('button', { name: 'About Prism' }).click();
    await expect(page.locator('h1')).toContainText('Prism');
  });

  test('shows 404 for unknown routes', async ({ page }) => {
    await page.goto('/nonexistent');
    await expect(page.locator('body')).toContainText('404');
  });

  test('sidebar shows active state for current route', async ({ page }) => {
    await page.goto('/settings');
    const settingsLink = page.locator('a[href="/settings"]');
    await expect(settingsLink).toHaveClass(/text-primary/);
  });
});
