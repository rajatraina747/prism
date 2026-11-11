import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('prism_splash_seen', '1'));
});

test.describe('Add sheet', () => {
  test('opens from any page with the keyboard and adds a batch', async ({ page }) => {
    await page.goto('/library');
    // The shortcut listener is attached by React after first render.
    await expect(page.getByRole('button', { name: /^Add/ })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+l');

    const dialog = page.getByRole('dialog', { name: 'Add downloads' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Links to add' })
      .fill('https://youtube.com/watch?v=one\nhttps://youtube.com/watch?v=two');
    await dialog.getByRole('button', { name: 'Add 2' }).click();

    // Lands on the Dashboard, which parses and queues both.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText(/2 added/)).toBeVisible({ timeout: 15000 });
  });

  test('a batch can be audio only', async ({ page }) => {
    await page.goto('/library');
    await page.getByRole('button', { name: /^Add/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Add downloads' });
    await expect(dialog.getByRole('button', { name: 'Audio only' })).toHaveCount(0);

    await dialog.getByRole('textbox', { name: 'Links to add' })
      .fill('https://youtube.com/watch?v=one\nhttps://youtube.com/watch?v=two');
    await dialog.getByRole('button', { name: 'Audio only' }).click();
    await expect(dialog.getByLabel('Quality', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('Audio quality').selectOption('mp3-192');
    await dialog.getByRole('button', { name: 'Add 2' }).click();

    await expect(page.getByText(/2 added/)).toBeVisible({ timeout: 15000 });
    const items = await page.evaluate(() => JSON.parse(localStorage.getItem('prism_queue') ?? '[]'));
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.settings.audioOnly).toBe(true);
      expect(item.settings.audioQuality).toBe('mp3-192');
      expect(item.settings.format).toBeNull();
    }
  });

  test('opens from the sidebar button', async ({ page }) => {
    await page.goto('/queue');
    await page.getByRole('button', { name: /^Add/ }).click();
    await expect(page.getByRole('dialog', { name: 'Add downloads' })).toBeVisible();
  });
});
