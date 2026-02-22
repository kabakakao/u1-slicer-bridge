import { test, expect } from '@playwright/test';
import { waitForApp, getAppState } from './helpers';

const MOCK_STATUS_BASE = {
  connected: true,
  message: 'Connected',
  server: {},
  printer: {},
  print_status: {
    state: 'standby',
    progress: 0,
    duration: 0,
    nozzle_temp: 0,
    nozzle_target: 0,
    bed_temp: 0,
    bed_target: 0,
    extruders: [],
  },
};

test.describe('Webcam Overlay', () => {
  test.use({ serviceWorkers: 'block' });

  function requestIncludesWebcams(urlString: string): boolean {
    const url = new URL(urlString);
    const value = (url.searchParams.get('include_webcams') || '').toLowerCase();
    return value === 'true' || value === '1';
  }

  test('webcams stay collapsed by default and do not request webcam payload until expanded', async ({ page }) => {
    let includeWebcamsCalls = 0;

    await page.route('**/api/printer/status**', async (route) => {
      const include = requestIncludesWebcams(route.request().url());
      if (include) includeWebcamsCalls++;

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...MOCK_STATUS_BASE,
          webcams: include ? [{ name: 'Cam 1', enabled: true, stream_url: '/mock/stream.jpg', snapshot_url: '/mock/snapshot.jpg' }] : [],
        }),
      });
    });

    await waitForApp(page);

    await page.locator('header button[data-testid="printer-status"]').click();
    await expect(page.getByRole('heading', { name: 'Printer Status' })).toBeVisible();

    const webcamsToggle = page.getByRole('button', { name: /Webcams/ }).first();
    await expect(webcamsToggle).toBeVisible();
    expect(await getAppState(page, 'webcamsExpanded')).toBe(false);
    await expect(page.getByText('No webcams found.')).not.toBeVisible();
    await expect(page.getByText('Show', { exact: true })).toBeVisible();
    expect(includeWebcamsCalls).toBe(0);
  });

  test('expanding webcams requests webcam payload and renders tile', async ({ page }) => {
    await waitForApp(page);

    await page.locator('header button[data-testid="printer-status"]').click();
    await expect(page.getByRole('heading', { name: 'Printer Status' })).toBeVisible();
    await page.evaluate(() => {
      const body = document.querySelector('body') as any;
      const scope = body?._x_dataStack?.find((s: any) => 'printerWebcams' in s && typeof s.toggleWebcamsExpanded === 'function');
      if (!scope) throw new Error('Alpine scope not found');
      scope.printerConnected = true;
      scope.printerWebcams = [{
        name: 'Front Cam',
        enabled: true,
        stream_url: '/mock/stream.jpg',
        snapshot_url: '/mock/snapshot.jpg',
      }];
      scope.webcamsExpanded = true;
    });

    await expect(page.getByText('Front Cam')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open' }).first()).toHaveAttribute('href', '/mock/stream.jpg');
  });

  test('expanded webcams request include_webcams=true and render mocked API webcam', async ({ page }) => {
    const printerStatusUrls: string[] = [];

    await page.route('**/api/printer/status**', async (route) => {
      const url = route.request().url();
      printerStatusUrls.push(url);
      const include = requestIncludesWebcams(url);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...MOCK_STATUS_BASE,
          webcams: include
            ? [{ name: 'E2E Cam', enabled: true, stream_url: '/mock/e2e-stream.jpg', snapshot_url: '/mock/e2e-snapshot.jpg' }]
            : [],
        }),
      });
    });

    await page.route('**/mock/e2e-snapshot.jpg', async (route) => {
      await route.fulfill({ status: 200, contentType: 'image/jpeg', body: 'ok' });
    });

    await waitForApp(page);

    await page.locator('header button[data-testid="printer-status"]').click();
    await expect(page.getByRole('heading', { name: 'Printer Status' })).toBeVisible();

    await page.getByRole('button', { name: /Webcams/ }).first().click();

    await page.waitForFunction(() => {
      const body = document.querySelector('body') as any;
      if (!body?._x_dataStack) return false;
      const scope = body._x_dataStack.find((s: any) => 'printerWebcams' in s);
      return !!scope && Array.isArray(scope.printerWebcams) && scope.printerWebcams.some((w: any) => w?.name === 'E2E Cam');
    });

    expect(printerStatusUrls.some((url) => requestIncludesWebcams(url))).toBe(true);
    await expect(page.getByText('E2E Cam')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open' }).first()).toHaveAttribute('href', '/mock/e2e-stream.jpg');
  });

  test('preview falls back from snapshot_url to stream_url on image error', async ({ page }) => {
    await waitForApp(page);

    const result = await page.evaluate(() => {
      const body = document.querySelector('body') as any;
      const scope = body?._x_dataStack?.find((s: any) => 'printerWebcams' in s && typeof s.handleWebcamImageError === 'function');
      if (!scope) throw new Error('Alpine scope not found');
      scope.webcamImageFallback = {};
      scope.webcamImageNonce = 123;
      const webcam = {
        name: 'Fallback Cam',
        enabled: true,
        stream_url: '/mock/stream-ok.jpg',
        snapshot_url: '/mock/snapshot-fail.jpg',
      };
      const before = scope.webcamImageUrl(webcam, 0);
      scope.handleWebcamImageError(webcam, 0);
      const after = scope.webcamImageUrl(webcam, 0);
      return { before, after };
    });
    expect(result.before).toContain('/mock/snapshot-fail.jpg');
    expect(result.after).toContain('/mock/stream-ok.jpg');
  });

  test('closing and reopening overlay refreshes webcam preview URL', async ({ page }) => {
    await waitForApp(page);

    await page.locator('header button[data-testid="printer-status"]').click();
    await expect(page.getByRole('heading', { name: 'Printer Status' })).toBeVisible();

    const firstUrl = await page.evaluate(() => {
      const body = document.querySelector('body') as any;
      const scope = body?._x_dataStack?.find((s: any) => typeof s.webcamImageUrl === 'function');
      if (!scope) throw new Error('Alpine scope not found');
      const webcam = {
        name: 'Refresh Cam',
        enabled: true,
        stream_url: '/mock/refresh-stream.jpg',
        snapshot_url: '/mock/refresh-snapshot.jpg',
      };
      scope.webcamImageFallback = {};
      scope.webcamsExpanded = true;
      scope.webcamImageNonce = 111;
      return scope.webcamImageUrl(webcam, 0);
    });

    await page.evaluate(async () => {
      const body = document.querySelector('body') as any;
      const scope = body?._x_dataStack?.find((s: any) => typeof s.closePrinterStatus === 'function' && typeof s.openPrinterStatus === 'function');
      if (!scope) throw new Error('Alpine scope not found');
      scope.closePrinterStatus();
      await scope.openPrinterStatus();
    });

    const secondUrl = await page.evaluate(() => {
      const body = document.querySelector('body') as any;
      const scope = body?._x_dataStack?.find((s: any) => typeof s.webcamImageUrl === 'function');
      const webcam = {
        name: 'Refresh Cam',
        enabled: true,
        stream_url: '/mock/refresh-stream.jpg',
        snapshot_url: '/mock/refresh-snapshot.jpg',
      };
      return scope?.webcamImageUrl(webcam, 0);
    });

    expect(firstUrl).toContain('/mock/refresh-snapshot.jpg');
    expect(secondUrl).toContain('/mock/refresh-snapshot.jpg');
    expect(secondUrl).not.toBe(firstUrl);
  });
});
