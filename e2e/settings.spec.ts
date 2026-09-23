import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

test.describe('Settings', () => {
  test('displays settings sections as tabs', async ({ page }) => {
    await page.goto('/settings');
    const sections = page.getByRole('tablist', { name: 'Settings sections' });
    for (const name of ['Video', 'BitTorrent', 'Speed & schedule', 'Network', 'Appearance', 'Updates']) {
      await expect(sections.getByRole('tab', { name })).toBeVisible();
    }
  });

  test('can switch to Appearance section and change theme', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Appearance' }).click();
    // The select is labelled by its row, not just positioned next to it.
    await page.getByRole('combobox', { name: 'Theme' }).selectOption('light');
    await expect(page.locator('html')).toHaveClass(/light/);
  });

  test('Reset to Defaults button is visible', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText('Reset to Defaults')).toBeVisible();
  });

  test('can navigate between settings sections', async ({ page }) => {
    await page.goto('/settings');

    await page.getByRole('tab', { name: 'Speed & schedule' }).click();
    await expect(page.getByRole('spinbutton', { name: 'Max concurrent downloads' })).toBeVisible();

    await page.getByRole('tab', { name: 'Notifications' }).click();
    await expect(page.getByRole('switch', { name: 'Sound effects' })).toBeVisible();
  });

  test('advanced torrent settings are behind a disclosure', async ({ page }) => {
    await page.goto('/settings?section=bittorrent');
    await expect(page.getByRole('switch', { name: 'DHT' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Show advanced settings' }).click();
    await expect(page.getByRole('switch', { name: 'DHT' })).toBeVisible();
  });

  test('old section links still land on the right section', async ({ page }) => {
    await page.goto('/settings?section=downloads');
    await expect(page.getByRole('combobox', { name: 'Browser cookies' })).toBeVisible();
  });

  test('exports a backup and imports it back', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Storage' }).click();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export…' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^prism-backup-\d{4}-\d{2}-\d{2}\.json$/);
    const file = await download.path();
    const backup = JSON.parse(readFileSync(file, 'utf8'));
    expect(backup.format).toBe('prism-export');
    expect(backup.settings.defaultSaveFolder).toBeUndefined();

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Import…' }).click(),
    ]);
    await chooser.setFiles(file);
    await expect(page.getByRole('alertdialog', { name: 'Import this backup?' })).toBeVisible();
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByText('Backup imported')).toBeVisible();
  });
});
