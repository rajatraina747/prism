import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  test('loads the dashboard by default', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h2')).toContainText('Dashboard');
  });

  test('navigates to Queue page', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/queue"]');
    await expect(page.locator('h2')).toContainText('Queue');
  });

  test('navigates to Library page', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/library"]');
    await expect(page.locator('h2')).toContainText('Library');
  });

  test('old routes redirect to Library', async ({ page }) => {
    for (const old of ['/downloads', '/failed', '/history']) {
      await page.goto(old);
      await expect(page.locator('h2')).toContainText('Library');
    }
  });

  test('navigates to Settings page', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/settings"]');
    await expect(page.locator('h2')).toContainText('Settings');
  });

  test('navigates to About page', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/about"]');
    await expect(page.locator('h2')).toContainText('Prism');
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
