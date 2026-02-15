import { test, expect } from '@playwright/test';
import { waitForApp, uploadFile, getAppState } from './helpers';

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
    const API = 'http://localhost:8000';

    // Upload a file
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
    const uploadId = upload.upload_id;

    // Delete it
    const delRes = await request.delete(`${API}/upload/${uploadId}`);
    expect(delRes.ok()).toBe(true);

    // Verify it's gone
    const getRes = await request.get(`${API}/upload/${uploadId}`);
    expect(getRes.status()).toBe(404);
  });

  test('delete job via API', async ({ request }) => {
    const API = 'http://localhost:8000';

    // Upload and slice a file
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
    if (job.status !== 'completed') {
      // Poll until complete
      for (let i = 0; i < 60; i++) {
        const statusRes = await request.get(`${API}/jobs/${job.job_id}`);
        const status = await statusRes.json();
        if (status.status === 'completed' || status.status === 'failed') break;
        await new Promise(r => setTimeout(r, 2_000));
      }
    }

    // Delete the job
    const delRes = await request.delete(`${API}/jobs/${job.job_id}`);
    expect(delRes.ok()).toBe(true);

    // Verify it's gone
    const getRes = await request.get(`${API}/jobs/${job.job_id}`);
    expect(getRes.status()).toBe(404);
  });

  test('upload preview endpoint returns image or 404', async ({ request }) => {
    const API = 'http://localhost:8000';

    // Upload file with embedded preview
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
    const upload = await uploadRes.json();

    const previewRes = await request.get(`${API}/uploads/${upload.upload_id}/preview`);
    // Either returns an image or 404 (not all 3MFs have embedded previews)
    expect([200, 404]).toContain(previewRes.status());
    if (previewRes.status() === 200) {
      const contentType = previewRes.headers()['content-type'];
      expect(contentType).toMatch(/image/);
    }
  });
});
