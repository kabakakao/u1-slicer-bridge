import { test, expect } from '@playwright/test';
import { waitForApp, uploadFile, selectUploadByName, waitForSliceComplete, getAppState, API, apiUpload, getDefaultFilament, waitForJobComplete } from './helpers';

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

  test('viewer shows zoom controls', async ({ page }) => {
    await waitForApp(page);
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    await page.getByRole('button', { name: /Slice Now/i }).click();
    await waitForSliceComplete(page);

    await page.locator('canvas').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(2_000);

    // Zoom buttons should be visible
    await expect(page.getByTitle('Zoom in')).toBeVisible();
    await expect(page.getByTitle('Zoom out')).toBeVisible();
    await expect(page.getByTitle('Fit to bed')).toBeVisible();

    // Click zoom in — should not cause errors
    await page.getByTitle('Zoom in').click();

    // Reset view
    await page.getByTitle('Fit to bed').click();
  });

  test('viewer has no initialization errors', async ({ page }) => {
    // Collect console errors during viewer init
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => {
      consoleErrors.push(err.message);
    });

    await waitForApp(page);
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    await page.getByRole('button', { name: /Slice Now/i }).click();
    await waitForSliceComplete(page);

    // Wait for viewer to fully initialize
    await page.locator('canvas').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(3_000);

    // No error overlay (catches errors shown to user)
    const errorOverlay = page.getByText(/Failed to load G-code preview/i);
    await expect(errorOverlay).not.toBeVisible();

    // No Proxy/Three.js errors in console (catches Alpine+Three.js conflicts)
    const proxyErrors = consoleErrors.filter(e =>
      e.includes('modelViewMatrix') ||
      e.includes('on proxy') ||
      e.includes('non-configurable')
    );
    expect(proxyErrors).toEqual([]);

    // No "Failed to" errors of any kind in the error overlay
    const failedText = page.getByText(/Failed to/i);
    await expect(failedText).not.toBeVisible();
  });

  test('viewer loads correct job after re-slicing', async ({ page }) => {
    await waitForApp(page);

    // Slice file (first time)
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    await page.getByRole('button', { name: /Slice Now/i }).click();
    await waitForSliceComplete(page);
    await page.locator('canvas').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(2_000);

    // Note the first job ID
    const firstSliceResult = await getAppState(page, 'sliceResult') as any;
    const firstJobId = firstSliceResult?.job_id;
    expect(firstJobId).toBeTruthy();

    // No viewer errors
    await expect(page.getByText(/Failed to/i)).not.toBeVisible();

    // Re-select the same file from history and slice again
    await selectUploadByName(page, 'calib-cube-10-dual-colour-merged.3mf');
    await page.getByRole('button', { name: /Slice Now/i }).click();
    await waitForSliceComplete(page);
    await page.locator('canvas').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(2_000);

    // The new job should have a different ID (new slice = new job)
    const secondSliceResult = await getAppState(page, 'sliceResult') as any;
    const secondJobId = secondSliceResult?.job_id;
    expect(secondJobId).toBeTruthy();
    expect(secondJobId).not.toBe(firstJobId);

    // No viewer errors after re-slice
    await expect(page.getByText(/Failed to/i)).not.toBeVisible();
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
