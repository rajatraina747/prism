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
    // Newest first by default, and the fixture stamps entry i one minute later
    // than entry i-1 — so the highest-numbered entry is the one at the top.
    await expect(page.getByText(`Library entry ${COUNT - 1}`, { exact: true })).toBeVisible();

    // Rows are options of a multi-select listbox, not plain list items — the
    // list is selectable now, and that is what a screen reader is told.
    const mounted = await page.getByRole('option').count();
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(100);

    // Scroll the page's scroller to the end; the last row gets mounted.
    await page.locator('main').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(page.getByText('Library entry 0', { exact: true })).toBeVisible();
    expect(await page.getByRole('option').count()).toBeLessThan(100);
  });

  // Ordering had no coverage of its own, so changing the default sort surfaced
  // as a confusing failure in the windowing test instead of here.
  test('sorts newest first, and can be switched to oldest', async ({ page }) => {
    await page.goto('/library');
    const firstRow = page.getByRole('option').first();
    await expect(firstRow).toContainText(`Library entry ${COUNT - 1}`);

    await page.getByRole('button', { name: 'Sort library' }).click();
    await page.getByRole('menuitem', { name: 'Oldest first' }).click();
    await expect(firstRow).toContainText('Library entry 0');
  });

  test('can be laid out as a grid', async ({ page }) => {
    await page.goto('/library');
    await page.getByRole('button', { name: 'Show as a grid' }).click();
    // Still a selectable listbox — a grid changes the layout, not the meaning,
    // so a screen reader is told the same thing either way.
    expect(await page.getByRole('option').count()).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Show as a list' })).toBeVisible();
  });

  test('search narrows the list', async ({ page }) => {
    await page.goto('/library');
    await page.getByRole('textbox', { name: 'Search library' }).fill('entry 42');
    await expect(page.getByText('Library entry 42', { exact: true })).toBeVisible();
    await expect(page.getByText('Library entry 43', { exact: true })).toHaveCount(0);
  });
});
