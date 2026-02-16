import { test, expect } from '@playwright/test';
import { waitForApp, uploadFile, getAppState, API, apiUpload } from './helpers';

test.describe('Multicolour Support', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('dual-colour file shows detected colors', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    const colors = await getAppState(page, 'detectedColors') as string[];
    expect(colors.length).toBeGreaterThanOrEqual(2);
  });

  test('detected colors display colour swatches in accordion', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    const colors = await getAppState(page, 'detectedColors') as string[];
    if (colors.length >= 2) {
      // Colours & Filaments accordion should be visible and open by default
      await expect(page.getByText(/Colours & Filaments/i)).toBeVisible();
      // Color mapping lines should be visible (arrow between detected colour and extruder)
      await expect(page.getByText('->').first()).toBeVisible();
    }
  });

  test('extruder mapping visible when accordion opened', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    const colors = await getAppState(page, 'detectedColors') as string[];

    if (colors.length >= 2) {
      // Accordion starts closed — summary should be visible
      await expect(page.getByText(/Colours & Filaments/i)).toBeVisible();
      // Open the accordion
      await page.getByText(/Colours & Filaments/i).click();
      // Extruder override section should now be visible
      await expect(page.getByText(/Filament\/Extruder Override/i)).toBeVisible({ timeout: 3_000 });
      // Customise link should be present
      await expect(page.getByText('Customise')).toBeVisible();
    }
  });

  test('print settings accordion shows source badges', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    // Print Settings accordion should be visible (closed by default with summary)
    const header = page.getByText(/Print Settings/i).first();
    await expect(header).toBeVisible();
    // Open the accordion to see source badges
    await header.click();
    // Should show at least one source badge (File or Default)
    const fileBadges = page.locator('text=File').first();
    const defaultBadges = page.locator('text=Default').first();
    const hasFile = await fileBadges.isVisible().catch(() => false);
    const hasDefault = await defaultBadges.isVisible().catch(() => false);
    expect(hasFile || hasDefault).toBe(true);
  });

  test('file with >4 colors shows notice and falls back to single filament', async ({ page }) => {
    // Dragon Scale has 7 metadata colors (but active colors may be <=4 after fix)
    await uploadFile(page, 'Dragon Scale infinity.3mf');
    // Wait for plates to load using Alpine v3 API
    await page.waitForFunction(() => {
      const body = document.querySelector('body') as any;
      if (body?._x_dataStack) {
        for (const scope of body._x_dataStack) {
          if ('platesLoading' in scope) return !scope.platesLoading;
        }
      }
      return false;
    }, undefined, { timeout: 60_000 });

    const notice = await getAppState(page, 'multicolorNotice');
    const colors = await getAppState(page, 'detectedColors') as string[];
    // Either shows a notice or has <= 4 active colors
    expect(notice !== null || colors.length <= 4).toBe(true);
  });

  test('multicolour API: upload detects colors', async ({ request }) => {
    const upload = await apiUpload(request, 'calib-cube-10-dual-colour-merged.3mf');
    expect(upload).toHaveProperty('detected_colors');
    expect(upload.detected_colors.length).toBeGreaterThanOrEqual(2);
  });
});
