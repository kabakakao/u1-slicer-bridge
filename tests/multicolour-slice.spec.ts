import { test, expect } from '@playwright/test';
import { API, apiUpload, getDefaultFilament, waitForJobComplete, apiSliceDualColour } from './helpers';

test.describe('Multicolour Slicing End-to-End (M11)', () => {
  test.setTimeout(180_000);

  test('dual-colour file slices with two filament_ids', async ({ request }) => {
    const upload = await apiUpload(request, 'calib-cube-10-dual-colour-merged.3mf');
    expect(upload.detected_colors?.length).toBeGreaterThanOrEqual(2);
    const job = await apiSliceDualColour(request, String(upload.upload_id));
    expect(job.status).toBe('completed');
    expect(job.metadata.layer_count).toBeGreaterThan(0);
  });

  test('dual-colour file stores filament_colors in job', async ({ request }) => {
    const upload = await apiUpload(request, 'calib-cube-10-dual-colour-merged.3mf');
    const job = await apiSliceDualColour(request, String(upload.upload_id), {
      filament_colors: ['#FF0000', '#0000FF'],
    });
    expect(job.status).toBe('completed');

    // Fetch job and check filament_colors
    const jobRes = await request.get(`${API}/jobs/${job.job_id}`, { timeout: 30_000 });
    const jobData = await jobRes.json();
    expect(jobData).toHaveProperty('filament_colors');
    if (jobData.filament_colors) {
      expect(jobData.filament_colors.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('multicolour slice with prime tower succeeds', async ({ request }) => {
    const upload = await apiUpload(request, 'calib-cube-10-dual-colour-merged.3mf');
    const job = await apiSliceDualColour(request, String(upload.upload_id), {
      enable_prime_tower: true,
      prime_tower_width: 40,
    });
    expect(job.status).toBe('completed');
  });

  test('single filament_id auto-expands for dual-colour file (segfault fix)', async ({ request }) => {
    // Previously this caused an OrcaSlicer segfault because model_settings.config
    // referenced extruder 2 but project_settings.config only defined 1 extruder.
    // The backend now auto-expands the filament list to match active extruder count.
    const upload = await apiUpload(request, 'calib-cube-10-dual-colour-merged.3mf');
    expect(upload.detected_colors?.length).toBeGreaterThanOrEqual(2);

    const fil = await getDefaultFilament(request);

    const res = await request.post(`${API}/uploads/${upload.upload_id}/slice`, {
      data: {
        filament_id: fil.id,  // Single filament on a dual-colour file
        layer_height: 0.2,
        infill_density: 15,
        supports: false,
      },
      timeout: 120_000,
    });
    expect(res.ok()).toBe(true);
    const job = await waitForJobComplete(request, await res.json());
    expect(job.status).toBe('completed');
    expect(job.metadata.layer_count).toBeGreaterThan(0);
  });

  test('>4 filament_ids rejected with 400', async ({ request }) => {
    const upload = await apiUpload(request, 'calib-cube-10-dual-colour-merged.3mf');
    const fil = await getDefaultFilament(request);

    const res = await request.post(`${API}/uploads/${upload.upload_id}/slice`, {
      data: {
        filament_ids: [fil.id, fil.id, fil.id, fil.id, fil.id],
        layer_height: 0.2,
        infill_density: 15,
        supports: false,
      },
      timeout: 30_000,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain('4 extruders');
  });

  test('slice request without filament_id or filament_ids returns 400', async ({ request }) => {
    const upload = await apiUpload(request, 'calib-cube-10-dual-colour-merged.3mf');

    const res = await request.post(`${API}/uploads/${upload.upload_id}/slice`, {
      data: {
        layer_height: 0.2,
        infill_density: 15,
        supports: false,
      },
      timeout: 30_000,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain('filament_id');
  });
});
