import { test, expect } from '@playwright/test';
import { waitForApp, uploadFile, getAppState, API, apiUpload, SLOW_TEST_TIMEOUT_MS, apiSliceDualColour } from './helpers';

test.describe('File Management', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('recent uploads list loads', async ({ page }) => {
    const uploads = await getAppState(page, 'uploads') as any[];
    // May or may not have uploads, but the state should be an array
    expect(Array.isArray(uploads)).toBe(true);
  });

  test('sliced files list loads', async ({ page }) => {
    const jobs = await getAppState(page, 'jobs') as any[];
    expect(Array.isArray(jobs)).toBe(true);
  });

  test('delete upload via API', async ({ request }) => {
    const upload = await apiUpload(request, 'calib-cube-10-dual-colour-merged.3mf');
    const uploadId = upload.upload_id;

    // Delete it
    const delRes = await request.delete(`${API}/upload/${uploadId}`, { timeout: 30_000 });
    expect(delRes.ok()).toBe(true);

    // Verify it's gone
    const getRes = await request.get(`${API}/upload/${uploadId}`, { timeout: 30_000 });
    expect(getRes.status()).toBe(404);
  });

  test('delete job via API', async ({ request }) => {
    const upload = await apiUpload(request, 'calib-cube-10-dual-colour-merged.3mf');
    const job = await apiSliceDualColour(request, String(upload.upload_id));

    // Delete the job
    const delRes = await request.delete(`${API}/jobs/${job.job_id}`, { timeout: 30_000 });
    expect(delRes.ok()).toBe(true);

    // Verify it's gone
    const getRes = await request.get(`${API}/jobs/${job.job_id}`, { timeout: 30_000 });
    expect(getRes.status()).toBe(404);
  });

  test('upload preview endpoint returns image or 404', async ({ request }) => {
    test.setTimeout(SLOW_TEST_TIMEOUT_MS);
    const upload = await apiUpload(request, 'Dragon Scale infinity.3mf');

    const previewRes = await request.get(`${API}/uploads/${upload.upload_id}/preview`, { timeout: 30_000 });
    // Either returns an image or 404 (not all 3MFs have embedded previews)
    expect([200, 404]).toContain(previewRes.status());
    if (previewRes.status() === 200) {
      const contentType = previewRes.headers()['content-type'];
      expect(contentType).toMatch(/image/);
    }
  });
});
