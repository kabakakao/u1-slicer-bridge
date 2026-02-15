import { test, expect } from '@playwright/test';
import { waitForApp, uploadFile, waitForSliceComplete, getAppState } from './helpers';

test.describe('Slicing Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('single-filament slice completes end-to-end', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');

    // Click Slice Now
    await page.getByRole('button', { name: /Slice Now/i }).click();

    // Should enter slicing state
    await expect(page.getByText(/Slicing Your Print/i)).toBeVisible({ timeout: 5_000 });

    // Wait for completion
    await waitForSliceComplete(page);

    // Verify complete step
    await expect(page.getByRole('heading', { name: /G-code is Ready/i })).toBeVisible();
  });

  test('completed slice shows metadata', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    await page.getByRole('button', { name: /Slice Now/i }).click();
    await waitForSliceComplete(page);

    // Should show summary info
    await expect(page.getByText('Estimated Time')).toBeVisible();
    await expect(page.getByText('Layers')).toBeVisible();
    await expect(page.getByText('File Size')).toBeVisible();
  });

  test('completed slice has download link', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    await page.getByRole('button', { name: /Slice Now/i }).click();
    await waitForSliceComplete(page);

    const downloadLink = page.getByRole('link', { name: /Download G-code/i });
    await expect(downloadLink).toBeVisible();
    const href = await downloadLink.getAttribute('href');
    expect(href).toContain('/download');
  });

  test('Start New Slice returns to upload step', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    await page.getByRole('button', { name: /Slice Now/i }).click();
    await waitForSliceComplete(page);

    await page.getByRole('button', { name: /Start New Slice/i }).click();
    const step = await getAppState(page, 'currentStep');
    expect(step).toBe('upload');
  });

  test('completed slice appears in Sliced Files list', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    await page.getByRole('button', { name: /Slice Now/i }).click();
    await waitForSliceComplete(page);

    // Go back to upload step
    await page.getByRole('button', { name: /Start New Slice/i }).click();

    // Sliced Files section should exist
    await expect(page.getByRole('heading', { name: 'Sliced Files' })).toBeVisible();
  });

  test('slice via API returns job with metadata', async ({ request }) => {
    const API = 'http://localhost:8000';

    // Upload file
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

    // Get default filament
    const filRes = await request.get(`${API}/filaments`);
    const filaments = (await filRes.json()).filaments;
    const defaultFil = filaments.find((f: any) => f.is_default) || filaments[0];

    // Slice
    const sliceRes = await request.post(`${API}/uploads/${upload.upload_id}/slice`, {
      data: {
        filament_id: defaultFil.id,
        layer_height: 0.2,
        infill_density: 15,
        supports: false,
      },
    });
    expect(sliceRes.ok()).toBe(true);
    const job = await sliceRes.json();
    expect(job).toHaveProperty('job_id');
    expect(job).toHaveProperty('status');

    // If synchronous completion
    if (job.status === 'completed') {
      expect(job).toHaveProperty('gcode_size_mb');
      expect(job).toHaveProperty('metadata');
      expect(job.metadata).toHaveProperty('layer_count');
    }
  });
});
