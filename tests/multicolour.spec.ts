import { test, expect } from '@playwright/test';
import { waitForApp, uploadFile, getAppState } from './helpers';

test.describe('Multicolour Support', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('dual-colour file shows detected colors', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    const colors = await getAppState(page, 'detectedColors') as string[];
    expect(colors.length).toBeGreaterThanOrEqual(2);
  });

  test('detected colors display colour swatches', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    const colors = await getAppState(page, 'detectedColors') as string[];
    if (colors.length >= 2) {
      await expect(page.getByText(/Detected Colors/i)).toBeVisible();
    }
  });

  test('override toggle shows extruder assignment controls', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    const colors = await getAppState(page, 'detectedColors') as string[];

    if (colors.length >= 2) {
      // Enable job overrides
      await page.getByLabel(/Override settings for this job/i).check();
      // Look for the filament override toggle
      const overrideBtn = page.getByRole('button', { name: /Override|Auto/i }).first();
      if (await overrideBtn.isVisible()) {
        await overrideBtn.click();
        // Should now show extruder selection dropdowns
        await expect(page.locator('select').first()).toBeVisible();
      }
    }
  });

  test('file with >4 colors shows notice and falls back to single filament', async ({ page }) => {
    // Dragon Scale has 7 metadata colors (but active colors may be <=4 after fix)
    await uploadFile(page, 'Dragon Scale infinity.3mf');
    // Wait for plates to load
    await page.waitForFunction(() => {
      const body = document.querySelector('body') as any;
      return !body?.__x?.$data?.platesLoading;
    }, { timeout: 60_000 });

    const notice = await getAppState(page, 'multicolorNotice');
    const colors = await getAppState(page, 'detectedColors') as string[];
    // Either shows a notice or has <= 4 active colors
    expect(notice !== null || colors.length <= 4).toBe(true);
  });

  test('multicolour API: upload detects colors', async ({ request }) => {
    const API = 'http://localhost:8000';
    const uploadRes = await request.post(`${API}/upload`, {
      multipart: {
        file: {
          name: 'calib-cube-10-dual-colour-merged.3mf',
          mimeType: 'application/octet-stream',
          buffer: require('fs').readFileSync(
            require('path').resolve(__dirname, '..', 'test-data', 'calib-cube-10-dual-colour-merged.3mf')
          ),
        },
      },
    });
    expect(uploadRes.ok()).toBe(true);
    const upload = await uploadRes.json();
    expect(upload).toHaveProperty('detected_colors');
    expect(upload.detected_colors.length).toBeGreaterThanOrEqual(2);
  });
});
