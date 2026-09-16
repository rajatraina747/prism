import { test, expect } from '@playwright/test';

const COUNT = 500;

/** A long library must stay light: only rows near the viewport are mounted. */
test.describe('Library', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((count) => {
      const history = Array.from({ length: count }, (_, i) => ({
        id: `h${i}`,
        metadata: {
          title: `Library entry ${i}`,
          duration: 60,
          thumbnail: '',
          source: { url: `https://example.com/v/${i}`, domain: 'example.com', addedAt: '2026-09-01T00:00:00Z' },
          formats: [],
        },
        settings: { format: null, destination: '~/Downloads/Prism', filename: `entry-${i}`, retryCount: 3, startImmediately: true },
        status: 'completed',
        completedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
        fileSize: 1024 * 1024,
      }));
      localStorage.setItem('prism_history', JSON.stringify(history));
      localStorage.setItem('prism_splash_seen', '1');
    }, COUNT);
  });

  test('windows a long list and still reaches the last entry', async ({ page }) => {
    await page.goto('/library');
    await expect(page.getByRole('tab', { name: new RegExp(`All\\s*${COUNT}`) })).toBeVisible();
    await expect(page.getByText('Library entry 0', { exact: true })).toBeVisible();

    // Rows are options of a multi-select listbox, not plain list items — the
    // list is selectable now, and that is what a screen reader is told.
    const mounted = await page.getByRole('option').count();
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(100);

    // Scroll the page's scroller to the end; the last row gets mounted.
    await page.locator('main').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(page.getByText(`Library entry ${COUNT - 1}`, { exact: true })).toBeVisible();
    expect(await page.getByRole('option').count()).toBeLessThan(100);
  });

  test('search narrows the list', async ({ page }) => {
    await page.goto('/library');
    await page.getByRole('textbox', { name: 'Search library' }).fill('entry 42');
    await expect(page.getByText('Library entry 42', { exact: true })).toBeVisible();
    await expect(page.getByText('Library entry 43', { exact: true })).toHaveCount(0);
  });
});
