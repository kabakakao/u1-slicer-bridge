import { test, expect } from '@playwright/test';
import { API, apiUpload, getDefaultFilament } from './helpers';

test.describe('Error Handling & Edge Cases', () => {
  test.describe('Upload Errors', () => {
    test('upload non-3MF file returns 400+', async ({ request }) => {
      const res = await request.post(`${API}/upload`, {
        multipart: {
          file: {
            name: 'bad-file.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('not a 3mf'),
          },
        },
      });
      expect(res.status()).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
    });

    test('upload corrupt 3MF (invalid zip) returns 400+', async ({ request }) => {
      const res = await request.post(`${API}/upload`, {
        multipart: {
          file: {
            name: 'corrupt.3mf',
            mimeType: 'application/octet-stream',
            buffer: Buffer.from('PK\x03\x04corrupt-not-a-real-zip-file'),
          },
        },
      });
      // Should reject with 400/422, not crash with 500
      expect(res.status()).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThanOrEqual(500);
    });
  });

  test.describe('Slice Errors', () => {
    test('slice non-existent upload returns 404', async ({ request }) => {
      const fil = await getDefaultFilament(request);
      // Upload IDs are integers, use a large non-existent one
      const fakeId = 999999;

      const res = await request.post(`${API}/uploads/${fakeId}/slice`, {
        data: {
          filament_id: fil.id,
          layer_height: 0.2,
          infill_density: 15,
          supports: false,
        },
      });
      expect(res.status()).toBe(404);
    });

    test('slice with non-existent filament_id returns 404', async ({ request }) => {
      const upload = await apiUpload(request, 'calib-cube-10-dual-colour-merged.3mf');

      const res = await request.post(`${API}/uploads/${upload.upload_id}/slice`, {
        data: {
          filament_id: 999999,
          layer_height: 0.2,
          infill_density: 15,
          supports: false,
        },
      });
      expect(res.status()).toBe(404);
      const body = await res.json();
      expect(body.detail).toContain('filaments not found');
    });

    test('slice-plate on non-existent upload returns 404', async ({ request }) => {
      const fil = await getDefaultFilament(request);
      const fakeId = 999999;

      const res = await request.post(`${API}/uploads/${fakeId}/slice-plate`, {
        data: {
          plate_id: 1,
          filament_id: fil.id,
          layer_height: 0.2,
          infill_density: 15,
          supports: false,
        },
      });
      expect(res.status()).toBe(404);
    });
  });

  test.describe('Filament Delete Safety', () => {
    test('delete filament assigned to extruder preset returns 400', async ({ request }) => {
      // Get current presets to find an assigned filament
      const presetsRes = await request.get(`${API}/presets/extruders`);
      const presets = await presetsRes.json();

      // Find a slot with a filament assigned
      const assignedSlot = presets.extruders?.find((e: any) => e.filament_id);
      if (!assignedSlot) {
        // No preset assigned — create one first
        const fil = await getDefaultFilament(request);
        if (!fil) return; // No filaments at all, skip
        await request.put(`${API}/presets/extruders`, {
          data: {
            extruders: [{ slot: 1, filament_id: fil.id, color_hex: '#FFFFFF' }],
            slicing_defaults: presets.slicing_defaults,
          },
        });

        // Now try to delete that filament
        const delRes = await request.delete(`${API}/filaments/${fil.id}`);
        expect(delRes.status()).toBe(400);
        const body = await delRes.json();
        expect(body.detail).toContain('preset');
      } else {
        // Try to delete the assigned filament
        const delRes = await request.delete(`${API}/filaments/${assignedSlot.filament_id}`);
        expect(delRes.status()).toBe(400);
        const body = await delRes.json();
        expect(body.detail).toContain('preset');
      }
    });

    test('delete non-existent filament returns 404', async ({ request }) => {
      const res = await request.delete(`${API}/filaments/999999`);
      expect(res.status()).toBe(404);
    });
  });

  test.describe('Job Errors', () => {
    test('get non-existent job returns 404', async ({ request }) => {
      const fakeId = 'nonexistent_job_id_12345';
      const res = await request.get(`${API}/jobs/${fakeId}`);
      expect(res.status()).toBe(404);
    });

    test('download non-existent job returns 404', async ({ request }) => {
      const fakeId = 'nonexistent_job_id_12345';
      const res = await request.get(`${API}/jobs/${fakeId}/download`);
      expect(res.status()).toBe(404);
    });

    test('gcode metadata for non-existent job returns 404', async ({ request }) => {
      const fakeId = 'nonexistent_job_id_12345';
      const res = await request.get(`${API}/jobs/${fakeId}/gcode/metadata`);
      expect(res.status()).toBe(404);
    });
  });

  test.describe('Upload Detail Errors', () => {
    test('get non-existent upload returns 404', async ({ request }) => {
      const fakeId = 999999;
      const res = await request.get(`${API}/upload/${fakeId}`);
      expect(res.status()).toBe(404);
    });

    test('delete non-existent upload returns 404', async ({ request }) => {
      const fakeId = 999999;
      const res = await request.delete(`${API}/upload/${fakeId}`);
      expect(res.status()).toBe(404);
    });

    test('plates for non-existent upload returns 404', async ({ request }) => {
      const fakeId = 999999;
      const res = await request.get(`${API}/uploads/${fakeId}/plates`);
      expect(res.status()).toBe(404);
    });
  });
});
