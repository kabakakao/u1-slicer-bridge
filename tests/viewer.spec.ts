import { test, expect } from '@playwright/test';
import { waitForApp, uploadFile, waitForSliceComplete } from './helpers';

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

    // Layer slider
    const slider = page.locator('input[type="range"]');
    await expect(slider).toBeVisible();
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
    const API = 'http://localhost:8000';

    // Upload and slice
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
    const upload = await uploadRes.json();

    const filRes = await request.get(`${API}/filaments`);
    const filaments = (await filRes.json()).filaments;
    const defaultFil = filaments.find((f: any) => f.is_default) || filaments[0];

    const sliceRes = await request.post(`${API}/uploads/${upload.upload_id}/slice`, {
      data: {
        filament_id: defaultFil.id,
        layer_height: 0.2,
        infill_density: 15,
        supports: false,
      },
    });
    const job = await sliceRes.json();

    // Wait for completion if async
    let jobId = job.job_id;
    if (job.status !== 'completed') {
      for (let i = 0; i < 60; i++) {
        const statusRes = await request.get(`${API}/jobs/${jobId}`);
        const status = await statusRes.json();
        if (status.status === 'completed') break;
        if (status.status === 'failed') throw new Error('Slice failed');
        await new Promise(r => setTimeout(r, 2_000));
      }
    }

    // Get metadata
    const metaRes = await request.get(`${API}/jobs/${jobId}/gcode/metadata`);
    expect(metaRes.ok()).toBe(true);
    const meta = await metaRes.json();
    expect(meta).toHaveProperty('layer_count');
    expect(meta.layer_count).toBeGreaterThan(0);

    // Get layers
    const layerRes = await request.get(`${API}/jobs/${jobId}/gcode/layers?start=0&count=5`);
    expect(layerRes.ok()).toBe(true);
    const layers = await layerRes.json();
    expect(layers).toHaveProperty('layers');
    expect(layers.layers.length).toBeGreaterThan(0);
  });
});
