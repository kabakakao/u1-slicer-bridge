import { test, expect } from '@playwright/test';
import { waitForApp, uploadFile, getAppState, fixture } from './helpers';

test.describe('Upload Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('uploading a single-plate 3MF reaches configure step', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    const step = await getAppState(page, 'currentStep');
    expect(step).toBe('configure');
    await expect(page.getByRole('heading', { name: 'Configure Print Settings' })).toBeVisible();
  });

  test('uploaded file appears in recent uploads', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    // Go back to upload step
    await page.getByRole('button', { name: 'Back to Upload' }).click();
    await expect(page.getByRole('heading', { name: 'Recent Uploads' })).toBeVisible();
    // Use .first() since many uploads may share the same filename
    await expect(page.getByText('calib-cube-10-dual-colour-merged.3mf').first()).toBeVisible();
  });

  test('configure step shows filament selection', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    // Should see either detected colors or filament dropdown
    // Should see the Colours & Filaments accordion
    await expect(page.getByText(/Colours & Filaments/i)).toBeVisible();
  });

  test('configure step shows Slice Now button', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    await expect(page.getByRole('button', { name: /Slice Now/i })).toBeVisible();
  });

  test('Back to Upload button returns to upload step', async ({ page }) => {
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    await page.getByRole('button', { name: 'Back to Upload' }).click();
    const step = await getAppState(page, 'currentStep');
    expect(step).toBe('upload');
  });

  test('selecting an existing upload goes to configure', async ({ page }) => {
    // First ensure there's at least one upload
    await uploadFile(page, 'calib-cube-10-dual-colour-merged.3mf');
    await page.getByRole('button', { name: 'Back to Upload' }).click();

    // Now click on the upload in the list
    const uploadRow = page.getByText('calib-cube-10-dual-colour-merged.3mf').first();
    await uploadRow.click();
    await page.waitForTimeout(1_000);
    const step = await getAppState(page, 'currentStep');
    expect(step).toBe('configure');
  });
});
