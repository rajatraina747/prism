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

  test('navigates to Downloads page', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/downloads"]');
    await expect(page.locator('h2')).toContainText('Completed Downloads');
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
