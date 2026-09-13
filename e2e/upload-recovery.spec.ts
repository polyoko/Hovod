import { test, expect } from '@playwright/test';

/** A queued transcode is tracked in Videos, never restored into the next upload batch. */
test('new video does not restore queued uploads', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel(/email/i).fill(process.env.E2E_EMAIL || 'admin@example.com');
  await page.getByLabel(/password/i).fill(process.env.E2E_PASSWORD || 'password123');
  await page.getByRole('button', { name: /sign in/i }).click();

  await page.goto('/videos/new');
  await page.setInputFiles('input[type="file"]', 'e2e/fixtures/sample.mp4');
  await page.getByRole('button', { name: /start processing/i }).click();
  await expect(page.getByText(/queued|ready/i).first()).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: /view video/i }).click();
  await page.waitForURL(/\/videos\/[^/]+$/);
  const assetId = new URL(page.url()).pathname.split('/').pop()!;
  await page.evaluate((pointer) => localStorage.setItem('hovod-bulk-upload-recovery-v1', JSON.stringify([pointer])), {
    localId: 'queued-upload', assetId, title: 'Queued upload', fileName: 'sample.mp4', fileSize: 1,
  });

  await page.goto('/videos/new');
  await expect(page.getByRole('list', { name: 'Selected files' })).toHaveCount(0);
});
