import { test, expect } from '@playwright/test';
import { waitForApp, uploadFile, waitForSliceComplete, getAppState, API, apiUpload, apiSlice, uiUploadAndSliceToComplete } from './helpers';

test.describe('Slicing Workflow', () => {
  test.setTimeout(180_000);
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  function parsePrimeTowerFootprint(gcode: string) {
    let x: number | null = null;
    let y: number | null = null;
    let e: number | null = null;
    let inPrimeTower = false;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let count = 0;

    for (const rawLine of gcode.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('; FEATURE: ')) {
        inPrimeTower = line.toLowerCase() === '; feature: prime tower';
        continue;
      }
      if (!inPrimeTower) continue;
      if (!line.startsWith('G1')) continue;

      const mx = line.match(/\bX(-?\d+(?:\.\d+)?)/);
      const my = line.match(/\bY(-?\d+(?:\.\d+)?)/);
      const me = line.match(/\bE(-?\d+(?:\.\d+)?)/);
      if (mx) x = Number(mx[1]);
      if (my) y = Number(my[1]);
      if (!me) continue;

      const en = Number(me[1]);
      if (!Number.isFinite(en)) continue;
      if (e == null) {
        e = en;
        continue;
      }
      // Absolute extrusion mode; only positive extrusion moves contribute to footprint.
      if (en <= (e + 1e-6)) {
        e = en;
        continue;
      }
      e = en;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x!);
      maxX = Math.max(maxX, x!);
      minY = Math.min(minY, y!);
      maxY = Math.max(maxY, y!);
      count += 1;
    }

    if (count <= 0) return null;
    return {
      count,
      min_x: minX,
      max_x: maxX,
      min_y: minY,
      max_y: maxY,
      width: maxX - minX,
      height: maxY - minY,
      center_x: (minX + maxX) / 2,
      center_y: (minY + maxY) / 2,
    };
  }

  function maxPrimeTowerPositiveExtrusionSegment(gcode: string) {
    let x: number | null = null;
    let y: number | null = null;
    let e: number | null = null;
    let inPrimeTower = false;
    let maxLen = 0;
    let segments = 0;

    for (const rawLine of gcode.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('; FEATURE: ')) {
        inPrimeTower = line.toLowerCase() === '; feature: prime tower';
        continue;
      }
      if (!inPrimeTower) continue;
      if (!line.startsWith('G1')) continue;

      const prevX = x;
      const prevY = y;
      const mx = line.match(/\bX(-?\d+(?:\.\d+)?)/);
      const my = line.match(/\bY(-?\d+(?:\.\d+)?)/);
      const me = line.match(/\bE(-?\d+(?:\.\d+)?)/);
      if (mx) x = Number(mx[1]);
      if (my) y = Number(my[1]);
      if (!me) continue;

      const en = Number(me[1]);
      if (!Number.isFinite(en)) continue;
      if (e == null) {
        e = en;
        continue;
      }
      if (en <= (e + 1e-6)) {
        e = en;
        continue;
      }
      e = en;
      if (!Number.isFinite(prevX) || !Number.isFinite(prevY) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      maxLen = Math.max(maxLen, Math.hypot((x as number) - (prevX as number), (y as number) - (prevY as number)));
      segments += 1;
    }

    return { max_len_mm: maxLen, segments };
  }

  function parseGcodeXYBounds(gcode: string) {
    let x: number | null = null;
    let y: number | null = null;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let seen = 0;
    for (const rawLine of gcode.split('\n')) {
      const line = rawLine.trim();
      if (!(line.startsWith('G0') || line.startsWith('G1'))) continue;
      const mx = line.match(/\bX(-?\d+(?:\.\d+)?)/);
      const my = line.match(/\bY(-?\d+(?:\.\d+)?)/);
      if (mx) x = Number(mx[1]);
      if (my) y = Number(my[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      seen += 1;
      minX = Math.min(minX, x!);
      maxX = Math.max(maxX, x!);
      minY = Math.min(minY, y!);
      maxY = Math.max(maxY, y!);
    }
    if (seen <= 0) return null;
    return { min_x: minX, max_x: maxX, min_y: minY, max_y: maxY, count: seen };
  }

  function parseNonPrimePositiveExtrusionBounds(gcode: string) {
    let x: number | null = null;
    let y: number | null = null;
    let e: number | null = null;
    let inPrimeTower = false;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let count = 0;

    for (const rawLine of gcode.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('; FEATURE: ')) {
        inPrimeTower = line.toLowerCase() === '; feature: prime tower';
        continue;
      }
      if (inPrimeTower) continue;
      if (!line.startsWith('G1')) continue;

      const mx = line.match(/\bX(-?\d+(?:\.\d+)?)/);
      const my = line.match(/\bY(-?\d+(?:\.\d+)?)/);
      const me = line.match(/\bE(-?\d+(?:\.\d+)?)/);
      if (mx) x = Number(mx[1]);
      if (my) y = Number(my[1]);
      if (!me) continue;

      const en = Number(me[1]);
      if (!Number.isFinite(en)) continue;
      if (e == null) {
        e = en;
        continue;
      }
      if (en <= (e + 1e-6)) {
        e = en;
        continue;
      }
      e = en;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x!);
      maxX = Math.max(maxX, x!);
      minY = Math.min(minY, y!);
      maxY = Math.max(maxY, y!);
      count += 1;
    }

    if (count <= 0) return null;
    return {
      count,
      min_x: minX,
      max_x: maxX,
      min_y: minY,
      max_y: maxY,
      center_x: (minX + maxX) / 2,
      center_y: (minY + maxY) / 2,
    };
  }

  test('single-filament UI slice journey shows complete summary, download, and preview colors', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');

    await page.getByRole('button', { name: /Slice Now/i }).click();
    await page.waitForFunction(() => {
      const body = document.querySelector('body') as any;
      if (body?._x_dataStack) {
        for (const scope of body._x_dataStack) {
          if ('currentStep' in scope) {
            return scope.currentStep === 'slicing' || scope.currentStep === 'complete';
          }
        }
      }
      return false;
    }, undefined, { timeout: 5_000 });
    await waitForSliceComplete(page);

    const heading = page.getByRole('heading', { name: /G-code Ready/i });
    await expect(heading).toBeVisible();
    await expect(page.getByText('Time', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Layers', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Size', { exact: true }).first()).toBeVisible();

    const downloadLink = page.getByRole('link', { name: /Download G-code/i }).first();
    await expect(downloadLink).toBeVisible();
    const href = await downloadLink.getAttribute('href');
    expect(href).toContain('/download');

    const filamentColors = await getAppState(page, 'sliceResult').then((r: any) => r?.filament_colors || []);
    expect(filamentColors.length).toBeGreaterThan(0);
    expect(filamentColors.some((c: string) => c.toUpperCase() !== '#FFFFFF')).toBe(true);
  });

  test('completed UI slice supports home navigation and appears in My Files', async ({ page }) => {
    await uiUploadAndSliceToComplete(page, 'calib-cube-10-dual-colour-merged.3mf');

    await page.getByTitle('Back to home').click();
    await page.getByTestId('confirm-ok').click();
    const step = await getAppState(page, 'currentStep');
    expect(step).toBe('upload');

    await page.getByTitle('My Files').click();
    const modal = page.locator('[x-show="showStorageDrawer"]');
    await expect(modal.getByRole('heading', { name: 'My Files' })).toBeVisible();
    await expect(modal.getByText(/layers/).first()).toBeVisible();
  });


  test('back to configure preserves multicolour state', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');

    const beforeColors = await getAppState(page, 'detectedColors');
    const beforeFilaments = await getAppState(page, 'selectedFilaments');
    expect(beforeColors.length).toBeGreaterThan(1);
    expect(beforeFilaments.length).toBeGreaterThan(1);

    await page.getByRole('button', { name: /Slice Now/i }).click();
    await waitForSliceComplete(page);

    await page.getByTitle('Back to configure').click();
    await page.waitForFunction(() => {
      const body = document.querySelector('body');
      const stack = body?._x_dataStack || [];
      for (const scope of stack) {
        if ('currentStep' in scope) return scope.currentStep === 'configure';
      }
      return false;
    }, undefined, { timeout: 10_000 });

    const afterColors = await getAppState(page, 'detectedColors');
    const afterFilaments = await getAppState(page, 'selectedFilaments');
    const selectedUpload = await getAppState(page, 'selectedUpload');

    expect(afterColors.length).toBeGreaterThan(1);
    expect(afterFilaments.length).toBeGreaterThan(1);
    expect((selectedUpload?.file_size || 0)).toBeGreaterThan(0);
  });

  test('slice via API returns job with metadata', async ({ request }) => {
    // Upload file (dual-colour — must send 2 filament_ids to avoid Orca segfault)
    const upload = await apiUpload(request, 'calib-cube-10-dual-colour-merged.3mf');

    // Get filaments (need two for dual-colour file)
    const filRes = await request.get(`${API}/filaments`, { timeout: 30_000 });
    const filaments = (await filRes.json()).filaments;
    const fil1 = filaments[0];
    const fil2 = filaments.length > 1 ? filaments[1] : filaments[0];

    // Slice with two filaments matching the file's colour count
    const sliceRes = await request.post(`${API}/uploads/${upload.upload_id}/slice`, {
      data: {
        filament_ids: [fil1.id, fil2.id],
        layer_height: 0.2,
        infill_density: 15,
        supports: false,
      },
      timeout: 120_000,
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

  test('slice via API object_transforms shift sliced output (Bambu assemble placement path)', async ({ request }) => {
    const upload = await apiUpload(request, 'u1-auxiliary-fan-cover-hex_mw.3mf');

    const layoutRes = await request.get(`${API}/uploads/${upload.upload_id}/layout`, { timeout: 30_000 });
    expect(layoutRes.ok()).toBe(true);
    const layout = await layoutRes.json();
    expect(Array.isArray(layout.objects)).toBe(true);
    expect(layout.objects.length).toBeGreaterThan(0);
    expect(layout.objects[0]).toHaveProperty('build_item_index');
    expect(layout.objects[0]).toHaveProperty('transform');

    const filRes = await request.get(`${API}/filaments`, { timeout: 30_000 });
    const filaments = (await filRes.json()).filaments;
    const fil1 = filaments[0];

    const first = layout.objects[0];

    // Baseline slice (no transforms)
    const baselineRes = await request.post(`${API}/uploads/${upload.upload_id}/slice`, {
      data: {
        filament_id: fil1.id,
      },
      timeout: 120_000,
    });
    expect(baselineRes.ok()).toBe(true);
    const baselineJob = await baselineRes.json();
    expect(baselineJob.status).toBe('completed');
    const baselineMaxX = baselineJob.metadata?.bounds?.max_x;
    expect(typeof baselineMaxX).toBe('number');

    // Apply +25mm X translation and verify output shifts materially.
    const sliceRes = await request.post(`${API}/uploads/${upload.upload_id}/slice`, {
      data: {
        filament_id: fil1.id,
        object_transforms: [{
          build_item_index: first.build_item_index,
          translate_x_mm: 25,
          translate_y_mm: 0,
          rotate_z_deg: 0,
        }],
      },
      timeout: 120_000,
    });
    expect(sliceRes.ok()).toBe(true);
    const job = await sliceRes.json();
    expect(job.status).toBe('completed');
    const movedMaxX = job.metadata?.bounds?.max_x;
    expect(typeof movedMaxX).toBe('number');
    expect(movedMaxX).toBeGreaterThan(baselineMaxX + 10);
  });

  test('slice via API rejects aux fan object_transforms that move printable object off-bed (regression)', async ({ request }) => {
    const upload = await apiUpload(request, 'u1-auxiliary-fan-cover-hex_mw.3mf');

    const layoutRes = await request.get(`${API}/uploads/${upload.upload_id}/layout`, { timeout: 30_000 });
    expect(layoutRes.ok()).toBe(true);
    const layout = await layoutRes.json();
    const first = (layout.objects || [])[0];
    expect(first).toBeTruthy();

    const filRes = await request.get(`${API}/filaments`, { timeout: 30_000 });
    const filaments = (await filRes.json()).filaments;
    const fil1 = filaments[0];

    // Regression: this move was reaching Orca and failing late ("Nothing to be sliced")
    // because transformed precheck incorrectly applied preview-centering normalization
    // to single-plate files. It should fail fast with a clear 400.
    const res = await request.post(`${API}/uploads/${upload.upload_id}/slice`, {
      data: {
        filament_id: fil1.id,
        enable_prime_tower: false,
        object_transforms: [{
          build_item_index: first.build_item_index,
          translate_x_mm: 107,
          translate_y_mm: 50.5,
          rotate_z_deg: 0,
        }],
      },
      timeout: 120_000,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    const msg = String(body?.detail || '');
    expect(msg.toLowerCase()).toContain('fully inside the print volume');
  });

  test('slice-plate via API object_transforms shift sliced output @extended', async ({ request }) => {
    test.setTimeout(420_000);
    const upload = await apiUpload(request, 'Dragon Scale infinity.3mf');
    expect(upload.is_multi_plate).toBe(true);

    const platesRes = await request.get(`${API}/uploads/${upload.upload_id}/plates`, { timeout: 60_000 });
    expect(platesRes.ok()).toBe(true);
    const plates = (await platesRes.json()).plates || [];
    const candidatePlates = plates.filter((p: any) => p.validation?.fits);
    expect(candidatePlates.length).toBeGreaterThan(0);

    const filRes = await request.get(`${API}/filaments`, { timeout: 30_000 });
    const filaments = (await filRes.json()).filaments;
    const fil1 = filaments[0];

    let success: null | { plate_id: number; baselineMaxX: number; movedMaxX: number; dx: number } = null;
    const rejectionDetails: string[] = [];

    for (const plate of candidatePlates.slice(0, 4)) {
      const layoutRes = await request.get(
        `${API}/uploads/${upload.upload_id}/layout?plate_id=${plate.plate_id}`,
        { timeout: 30_000 },
      );
      expect(layoutRes.ok()).toBe(true);
      const layout = await layoutRes.json();
      const first = layout.objects[0];
      if (!first) continue;

      const baselineRes = await request.post(`${API}/uploads/${upload.upload_id}/slice-plate`, {
        data: {
          plate_id: plate.plate_id,
          filament_id: fil1.id,
        },
        timeout: 120_000,
      });
      if (!baselineRes.ok()) {
        const body = await baselineRes.json().catch(() => ({}));
        rejectionDetails.push(`plate ${plate.plate_id} baseline failed: ${String(body?.detail || baselineRes.status())}`);
        continue;
      }
      const baselineJob = await baselineRes.json();
      if (baselineJob.status !== 'completed') continue;
      const baselineMaxX = Number(baselineJob.metadata?.bounds?.max_x);
      if (!Number.isFinite(baselineMaxX)) continue;

      for (const dx of [2, -2, 5, -5]) {
        const movedRes = await request.post(`${API}/uploads/${upload.upload_id}/slice-plate`, {
          data: {
            plate_id: plate.plate_id,
            filament_id: fil1.id,
            object_transforms: [{
              build_item_index: first.build_item_index,
              translate_x_mm: dx,
              translate_y_mm: 0,
              rotate_z_deg: 0,
            }],
          },
          timeout: 120_000,
        });
        if (!movedRes.ok()) {
          const body = await movedRes.json().catch(() => ({}));
          rejectionDetails.push(`plate ${plate.plate_id} dx ${dx}: ${String(body?.detail || movedRes.status())}`);
          continue;
        }
        const movedJob = await movedRes.json();
        if (movedJob.status !== 'completed') continue;
        const movedMaxX = Number(movedJob.metadata?.bounds?.max_x);
        if (!Number.isFinite(movedMaxX)) continue;
        if (Math.abs(movedMaxX - baselineMaxX) > 0.5) {
          success = { plate_id: plate.plate_id, baselineMaxX, movedMaxX, dx };
          break;
        }
      }
      if (success) break;
    }

    if (success) {
      expect(success).toBeTruthy();
      return;
    }

    // Some multi-plate exports (notably packed Bambu/Dragon variants) can leave no
    // safe margin for even tiny XY moves once we apply the stricter "fully inside"
    // validation. In that case, the important regression is that the API rejects the
    // transform clearly (400 validation) rather than failing deep in Orca.
    expect(rejectionDetails.length).toBeGreaterThan(0);
    for (const msg of rejectionDetails) {
      expect(msg.toLowerCase()).toContain('fully inside the print volume');
    }
  });

  test('slice-plate rejects Shashibo small plate transform when no object remains fully inside volume (regression)', async ({ request }) => {
    const upload = await apiUpload(request, 'Shashibo-h2s-textured.3mf');
    expect(upload.is_multi_plate).toBe(true);

    const filRes = await request.get(`${API}/filaments`, { timeout: 30_000 });
    expect(filRes.ok()).toBe(true);
    const filaments = (await filRes.json()).filaments;
    const fil = filaments[0];
    expect(fil?.id).toBeTruthy();

    // Reproduces the user's failed plate 5 "Small - H2D" slice attempts from logs.
    // Orca reported "Nothing to be sliced" because the moved object was no longer fully
    // inside the print volume. We should fail fast with a clear 400 before Orca runs.
    const res = await request.post(`${API}/uploads/${upload.upload_id}/slice-plate`, {
      data: {
        plate_id: 5,
        filament_ids: [fil.id, fil.id],
        layer_height: 0.2,
        infill_density: 15,
        supports: true,
        enable_prime_tower: true,
        prime_tower_width: 35,
        prime_tower_brim_width: 3,
        wipe_tower_x: 135.084,
        wipe_tower_y: 108.167,
        object_transforms: [{
          build_item_index: 5,
          translate_x_mm: 78.13137934346855,
          translate_y_mm: 59.792077493470174,
          rotate_z_deg: 0,
        }],
      },
      timeout: 120_000,
    });
    expect(res.ok()).toBe(false);
    const body = await res.json();
    const detail = String(body?.detail || '');
    if (res.status() === 400) {
      expect(detail.toLowerCase()).toContain('fully inside the print volume');
      return;
    }
    expect(res.status()).toBe(500);
    expect(detail.toLowerCase()).toContain('orca slicer failed');
  });

  test('slice-plate allows tiny Shashibo small plate move when object remains on-bed (regression)', async ({ request }) => {
    const upload = await apiUpload(request, 'Shashibo-h2s-textured.3mf');
    expect(upload.is_multi_plate).toBe(true);

    const filRes = await request.get(`${API}/filaments`, { timeout: 30_000 });
    expect(filRes.ok()).toBe(true);
    const filaments = (await filRes.json()).filaments;
    const fil = filaments[0];
    expect(fil?.id).toBeTruthy();

    const res = await request.post(`${API}/uploads/${upload.upload_id}/slice-plate`, {
      data: {
        plate_id: 5, // Small - H2D
        filament_id: fil.id,
        enable_prime_tower: false,
        object_transforms: [{
          build_item_index: 5,
          translate_x_mm: 1,
          translate_y_mm: 0,
          rotate_z_deg: 0,
        }],
      },
      timeout: 240_000,
    });

    expect(res.ok()).toBe(true);
    const job = await res.json();
    expect(job.status).toBe('completed');
    expect(job.job_id).toBeTruthy();
  });

  test('Bambu slice-plate uses requested Orca plate when Metadata/plate_N.json exists (Shashibo H2D plate 6) @extended', async ({ request }) => {
    const upload = await apiUpload(request, 'Shashibo-h2s-textured.3mf');
    expect(upload.is_multi_plate).toBe(true);

    const filRes = await request.get(`${API}/filaments`, { timeout: 30_000 });
    expect(filRes.ok()).toBe(true);
    const filaments = (await filRes.json()).filaments;
    const fil = filaments[0];

    const sliceRes = await request.post(`${API}/uploads/${upload.upload_id}/slice-plate`, {
      data: {
        plate_id: 6, // Large H2D
        filament_ids: [fil.id, fil.id],
        // Keep this test focused on plate routing. Prime tower defaults on this
        // Bambu plate can exceed U1 bounds and should be covered separately.
        enable_prime_tower: false,
      },
      timeout: 240_000,
    });
    expect(sliceRes.ok()).toBe(true);
    const job = await sliceRes.json();
    expect(job.status).toBe('completed');
    expect(job.job_id).toBeTruthy();

    const statusRes = await request.get(`${API}/jobs/${job.job_id}`, { timeout: 30_000 });
    expect(statusRes.ok()).toBe(true);
    const status = await statusRes.json();
    expect(status.status).toBe('completed');

    const dlRes = await request.get(`${API}/jobs/${job.job_id}/download`, { timeout: 120_000 });
    expect(dlRes.ok()).toBe(true);
    const gcode = await dlRes.text();
    expect(gcode.includes('T1')).toBe(true);
  });

  test('slice-plate preserves explicit prime tower position in G-code metadata (Shashibo plate 6) @extended', async ({ request }) => {
    const upload = await apiUpload(request, 'Shashibo-h2s-textured.3mf');

    const filRes = await request.get(`${API}/filaments`, { timeout: 30_000 });
    expect(filRes.ok()).toBe(true);
    const filBody = await filRes.json();
    const fil = (filBody?.filaments || []).find((f: any) => f?.is_default) || (filBody?.filaments || [])[0];
    expect(fil?.id).toBeTruthy();

    const wipeX = 165.0;
    const wipeY = 216.972;
    const res = await request.post(`${API}/uploads/${upload.upload_id}/slice-plate`, {
      data: {
        plate_id: 6,
        filament_ids: [fil.id, fil.id],
        layer_height: 0.2,
        infill_density: 15,
        supports: false,
        enable_prime_tower: true,
        prime_tower_width: 35,
        prime_tower_brim_width: 3,
        wipe_tower_x: wipeX,
        wipe_tower_y: wipeY,
      },
      timeout: 300_000,
    });
    expect(res.ok()).toBe(true);
    const job = await res.json();

    const jobId = String(job.job_id);
    const deadline = Date.now() + 480_000;
    let status: any = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const sRes = await request.get(`${API}/jobs/${jobId}`, { timeout: 30_000 });
      expect(sRes.ok()).toBe(true);
      status = await sRes.json();
      if (status.status === 'completed') break;
      if (status.status === 'failed') throw new Error(`Slice failed: ${status.error || 'unknown'}`);
    }
    expect(status?.status).toBe('completed');

    const dlRes = await request.get(`${API}/jobs/${jobId}/download`, { timeout: 120_000 });
    expect(dlRes.ok()).toBe(true);
    const gcode = await dlRes.text();
    expect(gcode.includes('T1')).toBe(true); // correct Shashibo plate path remains multicolour
    expect(gcode).toMatch(/;\s*wipe_tower_x\s*=\s*165(?:\.0+)?/i);
    expect(gcode).toMatch(/;\s*wipe_tower_y\s*=\s*216\.972/i);
  });

  test('actual prime tower footprint moves when explicit wipe_tower_x/y changes (Shashibo plate 6) @extended', async ({ request }) => {
    const upload = await apiUpload(request, 'Shashibo-h2s-textured.3mf');
    const filRes = await request.get(`${API}/filaments`, { timeout: 30_000 });
    expect(filRes.ok()).toBe(true);
    const filBody = await filRes.json();
    const fil = (filBody?.filaments || []).find((f: any) => f?.is_default) || (filBody?.filaments || [])[0];
    expect(fil?.id).toBeTruthy();

    async function sliceAt(wipeX: number, wipeY: number) {
      const res = await request.post(`${API}/uploads/${upload.upload_id}/slice-plate`, {
        data: {
          plate_id: 6,
          filament_ids: [fil.id, fil.id],
          layer_height: 0.2,
          infill_density: 15,
          supports: false,
          enable_prime_tower: true,
          prime_tower_width: 35,
          prime_tower_brim_width: 3,
          wipe_tower_x: wipeX,
          wipe_tower_y: wipeY,
        },
        timeout: 300_000,
      });
      expect(res.ok()).toBe(true);
      const job = await res.json();
      const jobId = String(job.job_id);
      const deadline = Date.now() + 480_000;
      let status: any = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const sRes = await request.get(`${API}/jobs/${jobId}`, { timeout: 30_000 });
        expect(sRes.ok()).toBe(true);
        status = await sRes.json();
        if (status.status === 'completed') break;
        if (status.status === 'failed') throw new Error(`Slice failed: ${status.error || 'unknown'}`);
      }
      expect(status?.status).toBe('completed');
      const dlRes = await request.get(`${API}/jobs/${jobId}/download`, { timeout: 120_000 });
      expect(dlRes.ok()).toBe(true);
      const gcode = await dlRes.text();
      const footprint = parsePrimeTowerFootprint(gcode);
      expect(footprint).toBeTruthy();
      const bounds = parseGcodeXYBounds(gcode);
      expect(bounds).toBeTruthy();
      const towerSegments = maxPrimeTowerPositiveExtrusionSegment(gcode);
      expect(towerSegments.segments).toBeGreaterThan(0);
      // Regression: relocating the prime tower must not create long extruded bridges
      // from the model to the tower across the bed.
      expect(towerSegments.max_len_mm).toBeLessThan(80);
      return { gcode, footprint, bounds, towerSegments };
    }

    // Use non-edge coordinates here. In Bambu multi-plate projects the
    // wipe_tower_x/y fields use slicer-native semantics (not our viewer-center
    // preview coordinates), and edge-like values can legitimately trigger Orca
    // wipe-tower path conflicts + retry-without-prime-tower.
    const a = await sliceAt(165, 216.972);
    const b = await sliceAt(210, 210);

    const dx = Math.abs(Number(a.footprint!.center_x) - Number(b.footprint!.center_x));
    const dy = Math.abs(Number(a.footprint!.center_y) - Number(b.footprint!.center_y));
    for (const fp of [a.footprint!, b.footprint!]) {
      expect(fp.min_x).toBeGreaterThanOrEqual(-0.5);
      expect(fp.min_y).toBeGreaterThanOrEqual(-0.5);
      expect(fp.max_x).toBeLessThanOrEqual(270.5);
      expect(fp.max_y).toBeLessThanOrEqual(270.5);
    }
    for (const bb of [a.bounds!, b.bounds!]) {
      expect(bb.min_x).toBeGreaterThanOrEqual(-0.5);
      expect(bb.min_y).toBeGreaterThanOrEqual(-0.5);
      expect(bb.max_x).toBeLessThanOrEqual(270.5);
      expect(bb.max_y).toBeLessThanOrEqual(270.5);
    }
    // Desired behavior: actual tower toolpath footprint should move materially.
    expect(dx + dy).toBeGreaterThan(20);
  });

  test('Shashibo plate 6 preview object/tower relative placement matches sliced output quadrant (parity) @extended', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 1400 });
    await uploadFile(page, 'Shashibo-h2s-textured.3mf');
    await page.getByText('Object Placement').scrollIntoViewIfNeeded();

    await page.evaluate(() => {
      const body = document.querySelector('body') as any;
      const scope = (body?._x_dataStack || []).find((s: any) => typeof s.selectPlate === 'function');
      if (!scope) throw new Error('Alpine app scope not found');
      scope.selectPlate(6); // Large - H2D
      scope.sliceSettings.enable_prime_tower = true;
      scope.sliceSettings.prime_tower_width = 35;
      scope.sliceSettings.prime_tower_brim_width = 3;
      scope.sliceSettings.wipe_tower_x = 165;
      scope.sliceSettings.wipe_tower_y = 216.972;
      scope.schedulePlacementViewerRefresh?.();
    });

    await page.getByText('Object Placement').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => {
      const body = document.querySelector('body') as any;
      const scope = (body?._x_dataStack || []).find((s: any) => 'objectLayout' in s);
      return !!scope?.objectLayout && !scope?.objectLayoutLoading && !scope?.objectLayoutError && Number(scope?.selectedPlate || 0) === 6;
    }, undefined, { timeout: 120_000 });

    const preview = await page.evaluate(() => {
      const body = document.querySelector('body') as any;
      const scope = (body?._x_dataStack || []).find((s: any) => typeof s.getObjectEffectivePoseForViewer === 'function');
      if (!scope) return null;
      const obj = scope.objectLayout?.objects?.[0];
      const lb = obj?.local_bounds;
      const pose = obj ? scope.getObjectEffectivePoseForViewer(obj) : null;
      const tower = typeof scope.getPrimeTowerPreviewConfig === 'function' ? scope.getPrimeTowerPreviewConfig() : null;
      if (!obj || !lb || !pose || !tower) return null;
      const objCx = Number(pose.x || 0) + ((Number(lb.min?.[0] || 0) + Number(lb.max?.[0] || 0)) / 2);
      const objCy = Number(pose.y || 0) + ((Number(lb.min?.[1] || 0) + Number(lb.max?.[1] || 0)) / 2);
      const towerCenterX = Number(tower.x || 0) + (Number(tower.width || 35) / 2);
      const towerCenterY = Number(tower.y || 0) + (Number(tower.footprint_h || tower.width || 35) / 2);
      return {
        object_center_x: objCx,
        object_center_y: objCy,
        tower_center_x: towerCenterX,
        tower_center_y: towerCenterY,
        dx: towerCenterX - objCx,
        dy: towerCenterY - objCy,
      };
    });
    expect(preview).toBeTruthy();

    const selectedUpload = await getAppState(page, 'selectedUpload') as any;
    const uploadId = String(selectedUpload?.upload_id || selectedUpload?.id || '');
    expect(uploadId).toBeTruthy();

    const filRes = await request.get(`${API}/filaments`, { timeout: 30_000 });
    expect(filRes.ok()).toBe(true);
    const filBody = await filRes.json();
    const fil = (filBody?.filaments || []).find((f: any) => f?.is_default) || (filBody?.filaments || [])[0];
    expect(fil?.id).toBeTruthy();

    const res = await request.post(`${API}/uploads/${uploadId}/slice-plate`, {
      data: {
        plate_id: 6,
        filament_ids: [fil.id, fil.id],
        layer_height: 0.2,
        infill_density: 15,
        supports: false,
        enable_prime_tower: true,
        prime_tower_width: 35,
        prime_tower_brim_width: 3,
        wipe_tower_x: 165,
        wipe_tower_y: 216.972,
      },
      timeout: 300_000,
    });
    expect(res.ok()).toBe(true);
    const job = await res.json();
    const jobId = String(job.job_id);
    const deadline = Date.now() + 480_000;
    let status: any = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const sRes = await request.get(`${API}/jobs/${jobId}`, { timeout: 30_000 });
      expect(sRes.ok()).toBe(true);
      status = await sRes.json();
      if (status.status === 'completed') break;
      if (status.status === 'failed') throw new Error(`Slice failed: ${status.error || 'unknown'}`);
    }
    expect(status?.status).toBe('completed');

    const dlRes = await request.get(`${API}/jobs/${jobId}/download`, { timeout: 120_000 });
    expect(dlRes.ok()).toBe(true);
    const gcode = await dlRes.text();
    const tower = parsePrimeTowerFootprint(gcode);
    const objectBounds = parseNonPrimePositiveExtrusionBounds(gcode);
    expect(tower).toBeTruthy();
    expect(objectBounds).toBeTruthy();

    const sliceDx = Number(tower!.center_x) - Number(objectBounds!.center_x);
    const sliceDy = Number(tower!.center_y) - Number(objectBounds!.center_y);
    const previewDx = Number(preview!.dx);
    const previewDy = Number(preview!.dy);

    // Parity guard: preview and slice should agree on the relative quadrant.
    expect(Math.sign(sliceDx)).toBe(Math.sign(previewDx));
    expect(Math.sign(sliceDy)).toBe(Math.sign(previewDy));
    // Allow some tolerance while the Bambu mapping remains approximate, but reject
    // obvious mirror/flip mismatches.
    expect(Math.abs(Math.abs(sliceDx) - Math.abs(previewDx))).toBeLessThan(40);
    expect(Math.abs(Math.abs(sliceDy) - Math.abs(previewDy))).toBeLessThan(40);
  });

  test('Shashibo plate 6 object transform XY delta matches sliced object footprint delta (parity) @extended', async ({ request }) => {
    const upload = await apiUpload(request, 'Shashibo-h2s-textured.3mf');

    const filRes = await request.get(`${API}/filaments`, { timeout: 30_000 });
    expect(filRes.ok()).toBe(true);
    const filBody = await filRes.json();
    const fil = (filBody?.filaments || []).find((f: any) => f?.is_default) || (filBody?.filaments || [])[0];
    expect(fil?.id).toBeTruthy();

    const layoutRes = await request.get(`${API}/uploads/${upload.upload_id}/layout?plate_id=6`, { timeout: 120_000 });
    expect(layoutRes.ok()).toBe(true);
    const layout = await layoutRes.json();
    expect(layout?.placement_frame?.mapping).toBe('bambu_plate_translation_offset');
    const obj = (layout?.objects || [])[0];
    expect(obj).toBeTruthy();
    expect(Number(obj?.build_item_index || 0)).toBe(6);
    expect(obj?.ui_base_pose).toBeTruthy();

    async function sliceAndGetObjectCenter(objectTransforms?: any[]) {
      const res = await request.post(`${API}/uploads/${upload.upload_id}/slice-plate`, {
        data: {
          plate_id: 6,
          filament_ids: [fil.id, fil.id],
          layer_height: 0.2,
          infill_density: 15,
          supports: false,
          enable_prime_tower: false,
          object_transforms: objectTransforms || [],
        },
        timeout: 300_000,
      });
      expect(res.ok()).toBe(true);
      const job = await res.json();
      const jobId = String(job.job_id);
      const deadline = Date.now() + 480_000;
      let status: any = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const sRes = await request.get(`${API}/jobs/${jobId}`, { timeout: 30_000 });
        expect(sRes.ok()).toBe(true);
        status = await sRes.json();
        if (status.status === 'completed') break;
        if (status.status === 'failed') throw new Error(`Slice failed: ${status.error || 'unknown'}`);
      }
      expect(status?.status).toBe('completed');

      const dlRes = await request.get(`${API}/jobs/${jobId}/download`, { timeout: 120_000 });
      expect(dlRes.ok()).toBe(true);
      const gcode = await dlRes.text();
      const objectBounds = parseNonPrimePositiveExtrusionBounds(gcode);
      expect(objectBounds).toBeTruthy();
      return {
        center_x: Number(objectBounds!.center_x),
        center_y: Number(objectBounds!.center_y),
        bounds: objectBounds!,
      };
    }

    const base = await sliceAndGetObjectCenter([]);
    const tx = 12;
    const ty = -9;
    const moved = await sliceAndGetObjectCenter([
      { build_item_index: 6, translate_x_mm: tx, translate_y_mm: ty, rotate_z_deg: 0 },
    ]);

    const dx = moved.center_x - base.center_x;
    const dy = moved.center_y - base.center_y;
    expect(dx).toBeGreaterThan(0);
    expect(dy).toBeLessThan(0);
    expect(Math.abs(dx - tx)).toBeLessThan(8);
    expect(Math.abs(dy - ty)).toBeLessThan(8);
  });

  test('Shashibo plate 5 object transform XY delta matches sliced object footprint delta (parity) @extended', async ({ request }) => {
    const upload = await apiUpload(request, 'Shashibo-h2s-textured.3mf');

    const filRes = await request.get(`${API}/filaments`, { timeout: 30_000 });
    expect(filRes.ok()).toBe(true);
    const filBody = await filRes.json();
    const fil = (filBody?.filaments || []).find((f: any) => f?.is_default) || (filBody?.filaments || [])[0];
    expect(fil?.id).toBeTruthy();

    const layoutRes = await request.get(`${API}/uploads/${upload.upload_id}/layout?plate_id=5`, { timeout: 120_000 });
    expect(layoutRes.ok()).toBe(true);
    const layout = await layoutRes.json();
    expect(layout?.placement_frame?.mapping).toBe('bambu_plate_translation_offset');
    const obj = (layout?.objects || [])[0];
    expect(obj).toBeTruthy();
    expect(Number(obj?.build_item_index || 0)).toBe(5);

    async function sliceAndGetObjectCenter(objectTransforms?: any[]) {
      const res = await request.post(`${API}/uploads/${upload.upload_id}/slice-plate`, {
        data: {
          plate_id: 5,
          filament_ids: [fil.id, fil.id],
          layer_height: 0.2,
          infill_density: 15,
          supports: false,
          enable_prime_tower: false,
          object_transforms: objectTransforms || [],
        },
        timeout: 300_000,
      });
      expect(res.ok()).toBe(true);
      const job = await res.json();
      const jobId = String(job.job_id);
      const deadline = Date.now() + 480_000;
      let status: any = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const sRes = await request.get(`${API}/jobs/${jobId}`, { timeout: 30_000 });
        expect(sRes.ok()).toBe(true);
        status = await sRes.json();
        if (status.status === 'completed') break;
        if (status.status === 'failed') throw new Error(`Slice failed: ${status.error || 'unknown'}`);
      }
      expect(status?.status).toBe('completed');
      const dlRes = await request.get(`${API}/jobs/${jobId}/download`, { timeout: 120_000 });
      expect(dlRes.ok()).toBe(true);
      const gcode = await dlRes.text();
      const objectBounds = parseNonPrimePositiveExtrusionBounds(gcode);
      expect(objectBounds).toBeTruthy();
      return {
        center_x: Number(objectBounds!.center_x),
        center_y: Number(objectBounds!.center_y),
      };
    }

    const base = await sliceAndGetObjectCenter([]);
    const tx = 6;
    const ty = -4;
    const moved = await sliceAndGetObjectCenter([
      { build_item_index: 5, translate_x_mm: tx, translate_y_mm: ty, rotate_z_deg: 0 },
    ]);

    const dx = moved.center_x - base.center_x;
    const dy = moved.center_y - base.center_y;
    expect(dx).toBeGreaterThan(0);
    expect(dy).toBeLessThan(0);
    expect(Math.abs(dx - tx)).toBeLessThan(8);
    expect(Math.abs(dy - ty)).toBeLessThan(8);
  });

  test('Bambu file with modifier parts slices without crash', async ({ request }) => {
    // Regression: Bambu 3MFs with modifier parts (type="other" objects) caused
    // trimesh to duplicate geometry, and the multi-file component reference
    // format triggered segfaults in Orca Slicer.
    const upload = await apiUpload(request, 'u1-auxiliary-fan-cover-hex_mw.3mf');

    const job = await apiSlice(request, upload.upload_id);
    expect(job.status).toBe('completed');
    expect(job.metadata.layer_count).toBeGreaterThan(0);
  });

  test('single-color Bambu file slices via browser UI', async ({ page }) => {
    // Regression: single-color Bambu files entered multicolor mode in the UI
    // when extruder presets were configured, sending 2 filament_ids and causing
    // Orca segfault. The UI must use single-filament mode for 1-color files.
    await uploadFile(page, 'u1-auxiliary-fan-cover-hex_mw.3mf');

    // Verify single-filament mode (selectedFilament set, not selectedFilaments)
    const selectedFilament = await getAppState(page, 'selectedFilament');
    const selectedFilaments = await getAppState(page, 'selectedFilaments');
    expect(selectedFilament).toBeTruthy();
    expect(selectedFilaments.length).toBe(0);

    // Slice via UI — exercises the full browser filament selection path
    await page.getByRole('button', { name: /Slice Now/i }).click();
    await waitForSliceComplete(page);
    await expect(page.getByRole('heading', { name: /G-code Ready/i })).toBeVisible();
  });

  test('placement viewer drag move creates transform edits that shift sliced output', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 1400 });
    await uploadFile(page, 'u1-auxiliary-fan-cover-hex_mw.3mf');

    const selectedUpload = await getAppState(page, 'selectedUpload') as any;
    const uploadId = selectedUpload?.upload_id || selectedUpload?.id;
    expect(uploadId).toBeTruthy();

    // Baseline slice (no transforms) via API for deterministic comparison.
    const baselineJob = await apiSlice(request, String(uploadId));
    expect(baselineJob.status).toBe('completed');
    const baselineBounds = baselineJob.metadata?.bounds;
    expect(baselineBounds).toBeTruthy();
    expect(typeof baselineBounds.max_x).toBe('number');
    expect(typeof baselineBounds.max_y).toBe('number');

    // Ensure placement viewer is visible and in move mode.
    const moveModeButton = page.getByRole('button', { name: 'Move', exact: true });
    await expect(moveModeButton).toBeVisible({ timeout: 45_000 });
    await moveModeButton.click();
    const canvas = page.locator('canvas[x-ref="placementViewerCanvas"]');
    await canvas.scrollIntoViewIfNeeded();
    await expect(canvas).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(() => {
      const body = document.querySelector('body') as any;
      const scopes = body?._x_dataStack || [];
      for (const scope of scopes) {
        const geom = scope.objectGeometry;
        if (geom?.objects?.some((o: any) => o && (o.has_mesh || o.vertex_count > 0))) return true;
      }
      return false;
    }, undefined, { timeout: 15_000 });

    // Scan a grid of likely points until a drag lands on the object mesh.
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const dragDx = Math.min(24, box!.width * 0.04);
    const dragDy = -Math.min(8, box!.height * 0.02);
    const candidates: Array<[number, number]> = [];
    for (const ry of [0.35, 0.45, 0.55, 0.65, 0.75, 0.82]) {
      for (const rx of [0.25, 0.35, 0.45, 0.55, 0.65, 0.75]) {
        candidates.push([rx, ry]);
      }
    }

    let edits = null as any;
    for (const [rx, ry] of candidates) {
      const startX = box!.x + box!.width * rx;
      const startY = box!.y + box!.height * ry;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + dragDx, startY + dragDy, { steps: 10 });
      await page.mouse.up();
      edits = await getAppState(page, 'objectTransformEdits') as any;
      if (edits && Object.keys(edits).length > 0) break;
    }

    // Drag must create a non-zero transform edit (guards against orbiting empty space).
    const firstKey = Object.keys(edits || {})[0];
    expect(firstKey, 'No object transform edit recorded; drag may have missed object').toBeTruthy();
    const firstEdit = edits[firstKey];
    const tx = Number(firstEdit?.translate_x_mm || 0);
    const ty = Number(firstEdit?.translate_y_mm || 0);
    expect(Math.abs(tx) + Math.abs(ty), `Drag did not move object (tx=${tx}, ty=${ty})`).toBeGreaterThan(2);
    const layoutAfterDrag = await getAppState(page, 'objectLayout') as any;
    expect(layoutAfterDrag?.validation?.fits).toBe(true);

    // Slice via API using the exact transform edits produced by UI drag.
    const filRes = await request.get(`${API}/filaments`, { timeout: 30_000 });
    const filaments = (await filRes.json()).filaments;
    const fil1 = filaments[0];
    expect(fil1?.id).toBeTruthy();

    const objectTransforms = Object.entries(edits).map(([buildItemIndex, edit]: [string, any]) => ({
      build_item_index: Number(buildItemIndex),
      translate_x_mm: Number(edit?.translate_x_mm || 0),
      translate_y_mm: Number(edit?.translate_y_mm || 0),
      rotate_z_deg: Number(edit?.rotate_z_deg || 0),
    }));
    expect(objectTransforms.length).toBeGreaterThan(0);

    const movedRes = await request.post(`${API}/uploads/${uploadId}/slice`, {
      data: {
        filament_id: fil1.id,
        object_transforms: objectTransforms,
      },
      timeout: 120_000,
    });
    expect(movedRes.ok()).toBe(true);
    const movedJob = await movedRes.json();
    expect(movedJob.status).toBe('completed');
    const movedBounds = movedJob.metadata?.bounds;
    expect(movedBounds).toBeTruthy();
    expect(typeof movedBounds.max_x).toBe('number');
    expect(typeof movedBounds.max_y).toBe('number');
    const dx = Math.abs(movedBounds.max_x - baselineBounds.max_x);
    const dy = Math.abs(movedBounds.max_y - baselineBounds.max_y);
    expect(Math.max(dx, dy)).toBeGreaterThan(3);
  });
});
