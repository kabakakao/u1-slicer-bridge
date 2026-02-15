import { test, expect } from '@playwright/test';
import { waitForApp, uploadFile, getAppState } from './helpers';

test.describe('Multi-Plate Support', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('multi-plate file shows plate count', async ({ page }) => {
    await uploadFile(page, 'Dragon Scale infinity.3mf');
    await expect(page.getByText(/Multi-plate file/i)).toBeVisible();
    await expect(page.getByText(/plates detected/i)).toBeVisible();
  });

  test('plate selection cards are shown for multi-plate files', async ({ page }) => {
    await uploadFile(page, 'Dragon Scale infinity.3mf');
    // Wait for plates to load (can take ~30s for large files)
    await page.waitForFunction(() => {
      const body = document.querySelector('body') as any;
      const data = body?.__x?.$data;
      return data?.plates?.length > 0 && !data?.platesLoading;
    }, { timeout: 60_000 });

    // Should have plate cards visible
    const plates = await getAppState(page, 'plates') as any[];
    expect(plates.length).toBeGreaterThan(1);
  });

  test('clicking a plate selects it', async ({ page }) => {
    await uploadFile(page, 'Dragon Scale infinity.3mf');
    await page.waitForFunction(() => {
      const body = document.querySelector('body') as any;
      return body?.__x?.$data?.plates?.length > 0;
    }, { timeout: 60_000 });

    // Click first plate radio button
    const firstPlate = page.locator('input[type="radio"][name="plate"]').first();
    await firstPlate.check();
    const selected = await getAppState(page, 'selectedPlate');
    expect(selected).not.toBeNull();
  });

  test('plates API returns correct structure', async ({ request }) => {
    // First upload a multi-plate file
    const API = 'http://localhost:8000';
    const uploadRes = await request.post(`${API}/upload`, {
      multipart: {
        file: {
          name: 'Dragon Scale infinity.3mf',
          mimeType: 'application/octet-stream',
          buffer: require('fs').readFileSync(
            require('path').resolve(__dirname, '..', 'test-data', 'Dragon Scale infinity.3mf')
          ),
        },
      },
    });
    expect(uploadRes.ok()).toBe(true);
    const upload = await uploadRes.json();
    expect(upload.is_multi_plate).toBe(true);

    // Get plates
    const platesRes = await request.get(`${API}/uploads/${upload.upload_id}/plates`);
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

  test('single-plate file does not show plate selector', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    // Should not show multi-plate indicator
    const isMulti = await getAppState(page, 'selectedUpload');
    expect((isMulti as any)?.is_multi_plate).toBeFalsy();
  });
});
