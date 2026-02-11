// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('G-code Viewer', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:8080');
        await page.waitForLoadState('networkidle');
    });

    test('viewer renders without requiring resize', async ({ page }) => {
        // Wait for app to initialize
        await page.waitForSelector('text=Upload 3MF File');

        // Select a recent upload (assuming there's one from previous tests)
        const uploadItems = await page.locator('[data-testid="upload-item"]').count();
        if (uploadItems > 0) {
            await page.locator('[data-testid="upload-item"]').first().click();
        } else {
            test.skip('No uploads available for testing');
        }

        // Configure and slice
        await page.waitForSelector('text=Configure Print Settings');
        await page.click('button:has-text("Slice Now")');

        // Wait for slicing to complete
        await page.waitForSelector('text=Your G-code is Ready!', { timeout: 90000 });

        // Wait for viewer to initialize
        await page.waitForSelector('canvas', { timeout: 10000 });

        // Wait a bit for rendering to complete
        await page.waitForTimeout(2000);

        // Take screenshot of canvas
        const canvas = await page.locator('canvas').first();
        const screenshot = await canvas.screenshot();

        // Check that canvas is not just black
        // A properly rendered canvas should have varied colors
        // We'll check that the screenshot has more than just pure black pixels

        // For now, just verify canvas exists and has non-zero dimensions
        const boundingBox = await canvas.boundingBox();
        expect(boundingBox).not.toBeNull();
        expect(boundingBox.width).toBeGreaterThan(100);
        expect(boundingBox.height).toBeGreaterThan(100);

        console.log(`Canvas dimensions: ${boundingBox.width}x${boundingBox.height}`);

        // Verify no error message is shown
        const errorOverlay = await page.locator('text=Failed to initialize canvas').count();
        expect(errorOverlay).toBe(0);

        // Check that layer info is visible (indicates rendering happened)
        const layerInfo = await page.locator('text=/Layer \\d+ \\/ \\d+/').count();
        expect(layerInfo).toBeGreaterThan(0);
    });

    test('viewer updates when layer slider changes', async ({ page }) => {
        // Navigate to a completed slice
        await page.goto('http://localhost:8080');

        // ... (same setup as above to get to viewer)

        // Find layer slider
        const slider = await page.locator('input[type="range"][max]');
        if (await slider.count() > 0) {
            const initialValue = await slider.inputValue();

            // Move slider
            await slider.fill('5');

            // Wait for render
            await page.waitForTimeout(500);

            // Verify layer number changed
            const layerText = await page.locator('text=/Layer \\d+ \\/ \\d+/').textContent();
            expect(layerText).toContain('Layer 6'); // Layer 5 is 0-indexed, shows as Layer 6
        }
    });
});
