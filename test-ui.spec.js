const { test, expect } = require('@playwright/test');

test.describe('U1 Slicer Bridge UI Tests', () => {
  test('should load the web UI and show all key elements', async ({ page }) => {
    console.log('📍 Navigating to http://localhost:8080...');
    await page.goto('http://localhost:8080', { waitUntil: 'networkidle', timeout: 15000 });

    console.log('✅ Page loaded');

    // Take screenshot of initial load
    await page.screenshot({ path: 'screenshots/01-home.png', fullPage: true });
    console.log('📸 Screenshot saved: screenshots/01-home.png');

    // Check page title
    const title = await page.title();
    console.log(`📄 Page title: "${title}"`);
    expect(title).toContain('U1 Slicer Bridge');

    // Check header
    const header = await page.locator('h1').textContent();
    console.log(`🎯 Header: "${header}"`);
    expect(header).toContain('U1 Slicer Bridge');

    // Check for upload section
    const uploadSection = await page.locator('h2:has-text("Upload 3MF File")');
    await expect(uploadSection).toBeVisible();
    console.log('✅ Upload section found');

    // Check for drag-drop zone
    const dropzone = await page.locator('[x-ref="dropzone"]');
    await expect(dropzone).toBeVisible();
    console.log('✅ Drag-drop zone found');

    // Check for file input
    const fileInput = await page.locator('input[type="file"]');
    expect(await fileInput.count()).toBeGreaterThan(0);
    console.log('✅ File input found');

    // Check printer status indicator (should show "Checking...", "Connected", or "Offline")
    const printerStatus = await page.locator('header').locator('text=/Checking|Connected|Offline|Error/i');
    expect(await printerStatus.count()).toBeGreaterThan(0);
    console.log('✅ Printer status indicator found');

    // Check for slice settings section (may be hidden initially)
    const layerHeightLabel = await page.locator('text=/Layer Height/i');
    const infillLabel = await page.locator('text=/Infill/i');

    console.log(`📊 Layer Height control: ${await layerHeightLabel.count() > 0 ? 'Found' : 'Not visible yet'}`);
    console.log(`📊 Infill control: ${await infillLabel.count() > 0 ? 'Found' : 'Not visible yet'}`);

    // Test console for errors
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    // Wait a bit for Alpine.js to initialize
    await page.waitForTimeout(2000);

    // Take another screenshot after Alpine initialization
    await page.screenshot({ path: 'screenshots/02-initialized.png', fullPage: true });
    console.log('📸 Screenshot saved: screenshots/02-initialized.png');

    // Check Alpine.js is working by checking for x-data attribute
    const alpineApp = await page.locator('[x-data="app()"]');
    await expect(alpineApp).toBeVisible();
    console.log('✅ Alpine.js app initialized');

    // Print any console errors
    if (errors.length > 0) {
      console.log('⚠️  Console errors detected:');
      errors.forEach(err => console.log(`   - ${err}`));
    } else {
      console.log('✅ No console errors');
    }
  });

  test('should test API connectivity', async ({ page }) => {
    console.log('📍 Testing API connectivity from UI...');

    await page.goto('http://localhost:8080', { waitUntil: 'networkidle' });

    // Wait for Alpine to initialize
    await page.waitForTimeout(3000);

    // Check if API health endpoint is reachable by the browser
    const apiHealthResponse = await page.evaluate(async () => {
      try {
        const response = await fetch('http://localhost:8000/healthz');
        return { ok: response.ok, status: response.status, data: await response.json() };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });

    console.log('🔌 API Health Check:', JSON.stringify(apiHealthResponse));
    expect(apiHealthResponse.ok).toBe(true);
    expect(apiHealthResponse.data.status).toBe('ok');

    // Check uploads endpoint
    const uploadsResponse = await page.evaluate(async () => {
      try {
        const response = await fetch('http://localhost:8000/upload');
        return { ok: response.ok, status: response.status, data: await response.json() };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });

    console.log('📤 Uploads endpoint:', JSON.stringify(uploadsResponse).substring(0, 200));
    expect(uploadsResponse.ok).toBe(true);
    expect(uploadsResponse.data).toHaveProperty('uploads');
    console.log(`✅ Found ${uploadsResponse.data.uploads.length} uploads in database`);
  });

  test('should check UI responsiveness', async ({ page }) => {
    console.log('📍 Testing UI responsiveness...');

    // Test desktop size
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('http://localhost:8080', { waitUntil: 'networkidle' });
    await page.screenshot({ path: 'screenshots/03-desktop.png', fullPage: true });
    console.log('📸 Desktop screenshot: screenshots/03-desktop.png');

    // Test tablet size
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'screenshots/04-tablet.png', fullPage: true });
    console.log('📸 Tablet screenshot: screenshots/04-tablet.png');

    // Test mobile size
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'screenshots/05-mobile.png', fullPage: true });
    console.log('📸 Mobile screenshot: screenshots/05-mobile.png');

    console.log('✅ UI renders at all viewport sizes');
  });
});

test.afterAll(async () => {
  console.log('\n🎉 All tests completed!');
  console.log('📁 Screenshots saved in screenshots/ directory');
});
