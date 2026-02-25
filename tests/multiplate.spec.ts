import { test, expect } from '@playwright/test';
import { waitForApp, uploadFile, selectUploadByName, getAppState, API, apiUpload } from './helpers';

test.describe('Multi-Plate Support', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('multi-plate file shows plate count @extended', async ({ page }) => {
    await uploadFile(page, 'Dragon Scale infinity.3mf');
    // Use more specific locator — the multi-plate info badge (not loading hints)
    await expect(page.locator('text=/\\d+ plates detected/i').first()).toBeVisible();
  });

  test('plate selection cards are shown for multi-plate files @extended', async ({ page }) => {
    // Reuse the Dragon Scale upload from previous test (server retains uploads)
    await selectUploadByName(page, 'Dragon Scale infinity.3mf');
    // Wait for plates to load using Alpine v3 API
    await page.waitForFunction(() => {
      const body = document.querySelector('body') as any;
      if (body?._x_dataStack) {
        for (const scope of body._x_dataStack) {
          if ('plates' in scope) return scope.plates?.length > 0 && !scope.platesLoading;
        }
      }
      return false;
    }, undefined, { timeout: 60_000 });

    // Should have plate cards visible
    const plates = await getAppState(page, 'plates') as any[];
    expect(plates.length).toBeGreaterThan(1);
  });

  test('clicking a plate selects it @extended', async ({ page }) => {
    // Reuse the Dragon Scale upload from previous test
    await selectUploadByName(page, 'Dragon Scale infinity.3mf');
    // Wait for plates using Alpine v3 API
    await page.waitForFunction(() => {
      const body = document.querySelector('body') as any;
      if (body?._x_dataStack) {
        for (const scope of body._x_dataStack) {
          if ('plates' in scope) return scope.plates?.length > 0;
        }
      }
      return false;
    }, undefined, { timeout: 60_000 });

    // Click first plate radio button
    const firstPlate = page.locator('input[type="radio"][name="plate"]').first();
    await firstPlate.check();
    const selected = await getAppState(page, 'selectedPlate');
    expect(selected).not.toBeNull();
  });

  test('plates API returns correct structure @extended', async ({ request }) => {
    const upload = await apiUpload(request, 'Dragon Scale infinity.3mf');
    expect(upload.is_multi_plate).toBe(true);

    // Get plates
    const platesRes = await request.get(`${API}/uploads/${upload.upload_id}/plates`, { timeout: 60_000 });
    expect(platesRes.ok()).toBe(true);
    const plates = await platesRes.json();
    expect(plates).toHaveProperty('plates');
    expect(plates.plates.length).toBeGreaterThan(1);

    // Each plate has expected fields
    const plate = plates.plates[0];
    expect(plate).toHaveProperty('plate_id');
    expect(plate).toHaveProperty('plate_name');
    expect(plate).toHaveProperty('validation');
    expect(plate.validation).toHaveProperty('fits');
  });

  test('single-plate file does not show plate selector @extended', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    // Should not show multi-plate indicator
    const isMulti = await getAppState(page, 'selectedUpload');
    expect((isMulti as any)?.is_multi_plate).toBeFalsy();
  });
});
