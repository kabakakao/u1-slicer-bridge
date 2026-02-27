import { test, expect } from '@playwright/test';
import { waitForApp, uploadFile, getAppState, apiUpload, apiSlice, API } from './helpers';

test.describe('STL Upload (M30)', () => {

  test('STL upload via API returns valid metadata', async ({ request }) => {
    const data = await apiUpload(request, '3DBenchy.stl');
    expect(data.upload_id).toBeGreaterThan(0);
    expect(data.filename).toBe('3DBenchy.stl');
    expect(data.file_size).toBeGreaterThan(0);
    expect(data.objects_count).toBeGreaterThanOrEqual(1);
    expect(data.bounds).toBeDefined();
    expect(data.fits).toBe(true);
    // STL uploads should NOT have multicolor or file print settings
    expect(data.has_multicolor).toBeUndefined();
    expect(data.file_print_settings).toBeUndefined();
    expect(data.is_multi_plate).toBeUndefined();
  });

  test('STL upload via UI reaches configure step', async ({ page }) => {
    await waitForApp(page);
    await uploadFile(page, '3DBenchy.stl');
    const step = await getAppState(page, 'currentStep');
    expect(step).toBe('configure');
    await expect(page.getByRole('heading', { name: 'Configure', exact: true })).toBeVisible();
  });

  test('STL upload appears in My Files with .stl filename', async ({ page }) => {
    await waitForApp(page);
    await uploadFile(page, '3DBenchy.stl');
    await page.getByTitle('Leave configure').click();
    await page.getByTestId('confirm-ok').click();
    await page.getByTitle('My Files').click();
    const modal = page.locator('[x-show="showStorageDrawer"]');
    await expect(modal.getByRole('heading', { name: 'My Files' })).toBeVisible();
    await expect(modal.getByText('3DBenchy.stl').first()).toBeVisible();
  });

  test('STL file can be sliced end-to-end', async ({ request }) => {
    const upload = await apiUpload(request, '3DBenchy.stl');
    const job = await apiSlice(request, upload.upload_id);
    expect(job.status).toBe('completed');
    expect(job.gcode_path).toBeTruthy();
  });

  test('rejects non-3mf/stl files', async ({ request }) => {
    // Upload a file with an unsupported extension
    const res = await request.post(`${API}/upload`, {
      multipart: {
        file: {
          name: 'readme.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('not a 3d model'),
        },
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain('.3mf and .stl');
  });
});
