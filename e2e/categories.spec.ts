import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Happy path: create a category, upload a batch into it, filter, export.
 * Precondition: `docker compose up -d --build` and E2E_EMAIL / E2E_PASSWORD set.
 * Fixture: e2e/fixtures/sample.mp4 — a ~2s clip so transcoding does not dominate.
 */

const CATEGORY = `Training ${Date.now()}`;
const FIXTURE = 'e2e/fixtures/sample.mp4';

test('categorize a batch at upload time and export it', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel(/email/i).fill(process.env.E2E_EMAIL || 'admin@example.com');
  await page.getByLabel(/password/i).fill(process.env.E2E_PASSWORD || 'password123');
  await page.getByRole('button', { name: /sign in/i }).click();

  // 1. Create the category in Settings
  await page.goto('/settings');
  await page.getByLabel('Category name').fill(CATEGORY);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(CATEGORY)).toBeVisible();

  // 2. Upload two files with that category selected for the whole batch
  await page.goto('/videos/new');
  await page.setInputFiles('input[type="file"]', [FIXTURE, FIXTURE]);
  await page.getByLabel('Category').selectOption({ label: CATEGORY });
  await page.getByRole('button', { name: /start processing/i }).click();
  // Queued is enough — transcoding is the worker's job, not this test's.
  await expect(page.getByText(/queued|ready/i).first()).toBeVisible({ timeout: 60_000 });

  // 3. Filter the list down to the category
  await page.goto('/videos');
  await page.getByLabel('Category').selectOption({ label: CATEGORY });
  await expect(page.getByRole('button', { name: /open /i })).toHaveCount(2);

  // 4. Export and check the CSV carries the category
  const download = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /export csv/i }).click(),
  ]).then(([d]) => d);

  const csv = readFileSync(await download.path(), 'utf8').trim().split('\n');
  expect(csv[0]).toContain('category');
  expect(csv).toHaveLength(3); // header + 2 rows
  expect(csv[1]).toContain(CATEGORY);
  expect(csv[2]).toContain(CATEGORY);
});
