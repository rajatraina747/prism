import { test, expect } from '@playwright/test';

test.describe('Settings', () => {
  test('displays settings sections', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText('General')).toBeVisible();
    await expect(page.getByText('Downloads')).toBeVisible();
    await expect(page.getByText('Appearance')).toBeVisible();
    await expect(page.getByText('Updates')).toBeVisible();
  });

  test('can switch to Appearance section and change theme', async ({ page }) => {
    await page.goto('/settings');
    await page.getByText('Appearance').click();
    await expect(page.getByText('Theme')).toBeVisible();

    // Change theme to light
    const select = page.locator('select');
    await select.selectOption('light');

    // The html element should have the light class
    await expect(page.locator('html')).toHaveClass(/light/);
  });

  test('Reset to Defaults button is visible', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText('Reset to Defaults')).toBeVisible();
  });

  test('can navigate between settings sections', async ({ page }) => {
    await page.goto('/settings');

    await page.getByRole('button', { name: 'Queue' }).click();
    await expect(page.getByText('Max concurrent downloads')).toBeVisible();

    await page.getByRole('button', { name: 'Notifications' }).click();
    await expect(page.getByText('Sound effects')).toBeVisible();
  });
});
