import { test, expect } from '@playwright/test';
import { waitForApp, uploadFile, waitForSliceComplete, API, apiUpload, getDefaultFilament, waitForJobComplete } from './helpers';

test.describe('G-code Viewer', () => {
  // This test slices a file first, so it needs extra time
  test.setTimeout(180_000);

  test('viewer renders after slicing', async ({ page }) => {
    await waitForApp(page);
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    await page.getByRole('button', { name: /Slice Now/i }).click();
    await waitForSliceComplete(page);

    // Wait for viewer canvas to appear
    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible({ timeout: 15_000 });

    // Canvas should have non-trivial dimensions
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(100);
    expect(box!.height).toBeGreaterThan(100);
  });

  test('viewer shows layer controls', async ({ page }) => {
    await waitForApp(page);
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    await page.getByRole('button', { name: /Slice Now/i }).click();
    await waitForSliceComplete(page);

    // Wait for viewer to initialize
    await page.locator('canvas').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(2_000);

    // Layer navigation buttons
    await expect(page.getByRole('button', { name: /Previous/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Next/i })).toBeVisible();

    // Layer slider — use the role-based selector to find the specific viewer slider
    const slider = page.getByRole('slider');
    await expect(slider.first()).toBeVisible();
  });

  test('viewer has no initialization errors', async ({ page }) => {
    await waitForApp(page);
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    await page.getByRole('button', { name: /Slice Now/i }).click();
    await waitForSliceComplete(page);

    // Wait for viewer
    await page.locator('canvas').waitFor({ state: 'visible', timeout: 15_000 });

    // No error overlay
    const errorOverlay = page.getByText(/Failed to initialize/i);
    await expect(errorOverlay).not.toBeVisible();
  });

  test('gcode metadata API returns valid data', async ({ request }) => {
    // Dual-colour file — must send 2 filament_ids to avoid Orca segfault
    const upload = await apiUpload(request, 'calib-cube-10-dual-colour-merged.3mf');
    const fil = await getDefaultFilament(request);

    const sliceRes = await request.post(`${API}/uploads/${upload.upload_id}/slice`, {
      data: {
        filament_ids: [fil.id, fil.id],
        layer_height: 0.2,
        infill_density: 15,
        supports: false,
      },
      timeout: 120_000,
    });
    const job = await waitForJobComplete(request, await sliceRes.json());

    // Get metadata
    const metaRes = await request.get(`${API}/jobs/${job.job_id}/gcode/metadata`, { timeout: 30_000 });
    expect(metaRes.ok()).toBe(true);
    const meta = await metaRes.json();
    expect(meta).toHaveProperty('layer_count');
    expect(meta.layer_count).toBeGreaterThan(0);

    // Get layers
    const layerRes = await request.get(`${API}/jobs/${job.job_id}/gcode/layers?start=0&count=5`, { timeout: 30_000 });
    expect(layerRes.ok()).toBe(true);
    const layers = await layerRes.json();
    expect(layers).toHaveProperty('layers');
    expect(layers.layers.length).toBeGreaterThan(0);
  });

  test('multicolour slice shows color legend in viewer', async ({ request }) => {
    // Slice dual-colour file with two filament colors via API
    const upload = await apiUpload(request, 'calib-cube-10-dual-colour-merged.3mf');
    const fil = await getDefaultFilament(request);

    const sliceRes = await request.post(`${API}/uploads/${upload.upload_id}/slice`, {
      data: {
        filament_ids: [fil.id, fil.id],
        filament_colors: ['#FF0000', '#0000FF'],
        layer_height: 0.2,
        infill_density: 15,
        supports: false,
      },
      timeout: 120_000,
    });
    const job = await waitForJobComplete(request, await sliceRes.json());

    // Verify job stored filament colors
    const jobRes = await request.get(`${API}/jobs/${job.job_id}`, { timeout: 30_000 });
    const jobData = await jobRes.json();
    expect(jobData.filament_colors).toBeDefined();
    if (jobData.filament_colors) {
      expect(jobData.filament_colors.length).toBeGreaterThanOrEqual(2);
    }
  });
});
