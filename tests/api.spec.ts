import { test, expect } from '@playwright/test';

const API = 'http://localhost:8000';

test.describe('API Endpoints', () => {
  test('GET /healthz returns ok', async ({ request }) => {
    const res = await request.get(`${API}/healthz`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('GET /upload returns uploads list', async ({ request }) => {
    const res = await request.get(`${API}/upload`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty('uploads');
    expect(Array.isArray(body.uploads)).toBe(true);
  });

  test('GET /filaments returns filaments list', async ({ request }) => {
    const res = await request.get(`${API}/filaments`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty('filaments');
    expect(Array.isArray(body.filaments)).toBe(true);
  });

  test('GET /jobs returns jobs list', async ({ request }) => {
    const res = await request.get(`${API}/jobs`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    // API returns a bare array, not { jobs: [...] }
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /presets/extruders returns presets', async ({ request }) => {
    const res = await request.get(`${API}/presets/extruders`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty('extruders');
    expect(body).toHaveProperty('slicing_defaults');
  });

  test('GET /printer/status returns status', async ({ request }) => {
    const res = await request.get(`${API}/printer/status`);
    // May be ok or error depending on moonraker config, but should not 500
    expect(res.status()).toBeLessThan(500);
  });

  test('POST /filaments/init-defaults succeeds', async ({ request }) => {
    const res = await request.post(`${API}/filaments/init-defaults`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    // Returns { message: "..." } when filaments already exist or were created
    expect(body).toHaveProperty('message');
  });

  test('filaments have required fields', async ({ request }) => {
    const res = await request.get(`${API}/filaments`);
    const body = await res.json();
    if (body.filaments.length > 0) {
      const f = body.filaments[0];
      expect(f).toHaveProperty('id');
      expect(f).toHaveProperty('name');
      expect(f).toHaveProperty('material');
      expect(f).toHaveProperty('nozzle_temp');
      expect(f).toHaveProperty('bed_temp');
      expect(f).toHaveProperty('bed_type');
    }
  });

  test('POST /upload rejects non-3mf file', async ({ request }) => {
    const res = await request.post(`${API}/upload`, {
      multipart: {
        file: {
          name: 'bad.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('not a 3mf file'),
        },
      },
    });
    // Should reject with 400 or 422
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });
});
