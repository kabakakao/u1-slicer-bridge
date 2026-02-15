import { Page, expect, APIRequestContext } from '@playwright/test';
import path from 'path';
import fs from 'fs';

export const API = 'http://localhost:8000';

/** Wait for Alpine.js to fully initialize the app */
export async function waitForApp(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Wait for Alpine.js v3 to mount (uses _x_dataStack instead of v2's __x)
  await page.waitForFunction(() => {
    const body = document.querySelector('body');
    return body && (
      (body as any)._x_dataStack !== undefined ||
      (body as any).__x !== undefined
    );
  }, { timeout: 10_000 });
}

/** Get Alpine.js app state */
export async function getAppState(page: Page, key: string) {
  return page.evaluate((k) => {
    const body = document.querySelector('body') as any;
    // Alpine.js v3 uses _x_dataStack (array of reactive proxies)
    if (body?._x_dataStack) {
      for (const scope of body._x_dataStack) {
        if (k in scope) return scope[k];
      }
      return undefined;
    }
    // Fallback to Alpine.js v2 API
    return body?.__x?.$data?.[k];
  }, key);
}

/** Resolve path to a test fixture file */
export function fixture(name: string) {
  return path.resolve(__dirname, '..', 'test-data', name);
}

/** Upload a 3MF file via the hidden file input */
export async function uploadFile(page: Page, fixtureName: string) {
  const filePath = fixture(fixtureName);
  const fileInput = page.locator('input[type="file"][accept=".3mf"]');
  await fileInput.setInputFiles(filePath);
  // Wait for upload to complete and move to configure step
  await page.waitForFunction((expected) => {
    const body = document.querySelector('body') as any;
    if (body?._x_dataStack) {
      for (const scope of body._x_dataStack) {
        if ('currentStep' in scope) return scope.currentStep === expected;
      }
    }
    return body?.__x?.$data?.currentStep === expected;
  }, 'configure', { timeout: 30_000 });
}

/** Navigate to the configure step for an already-uploaded file by filename */
export async function selectUploadByName(page: Page, filename: string) {
  // Find the upload row containing this filename and click its Slice button
  const row = page.locator(`text=${filename}`).first();
  await expect(row).toBeVisible({ timeout: 5_000 });
  // Click the row to select it — the row itself is clickable
  await row.click();
  // Wait for configure step
  await page.waitForFunction((expected) => {
    const body = document.querySelector('body') as any;
    if (body?._x_dataStack) {
      for (const scope of body._x_dataStack) {
        if ('currentStep' in scope) return scope.currentStep === expected;
      }
    }
    return body?.__x?.$data?.currentStep === expected;
  }, 'configure', { timeout: 30_000 });
}

/** Wait for slicing to complete (up to 2 minutes) */
export async function waitForSliceComplete(page: Page) {
  await page.waitForFunction((expected) => {
    const body = document.querySelector('body') as any;
    if (body?._x_dataStack) {
      for (const scope of body._x_dataStack) {
        if ('currentStep' in scope) return scope.currentStep === expected;
      }
    }
    return body?.__x?.$data?.currentStep === expected;
  }, 'complete', { timeout: 120_000 });
}

/** Get the current step from Alpine state */
export async function getCurrentStep(page: Page): Promise<string> {
  return getAppState(page, 'currentStep') as Promise<string>;
}

/** Upload a 3MF file via API and return the upload response */
export async function apiUpload(request: APIRequestContext, fixtureName: string) {
  const filePath = fixture(fixtureName);
  const buffer = fs.readFileSync(filePath);
  const res = await request.post(`${API}/upload`, {
    multipart: {
      file: {
        name: fixtureName,
        mimeType: 'application/octet-stream',
        buffer,
      },
    },
    timeout: 60_000,  // Large files (e.g. Dragon Scale 3.6MB) need more than 15s
  });
  expect(res.ok()).toBe(true);
  return res.json();
}

/** Get the default filament (or first available) */
export async function getDefaultFilament(request: APIRequestContext) {
  const res = await request.get(`${API}/filaments`);
  const body = await res.json();
  const filaments = body.filaments;
  return filaments.find((f: any) => f.is_default) || filaments[0];
}

/** Slice via API and wait for completion, returning the finished job */
export async function apiSlice(
  request: APIRequestContext,
  uploadId: string,
  options: Record<string, any> = {},
) {
  const fil = await getDefaultFilament(request);
  const data = {
    filament_id: fil.id,
    layer_height: 0.2,
    infill_density: 15,
    supports: false,
    ...options,
  };
  const res = await request.post(`${API}/uploads/${uploadId}/slice`, {
    data,
    timeout: 120_000,
  });
  expect(res.ok()).toBe(true);
  const job = await res.json();
  return waitForJobComplete(request, job);
}

/** Slice a specific plate via API and wait for completion */
export async function apiSlicePlate(
  request: APIRequestContext,
  uploadId: string,
  plateId: number,
  options: Record<string, any> = {},
) {
  const fil = await getDefaultFilament(request);
  const data = {
    plate_id: plateId,
    filament_id: fil.id,
    layer_height: 0.2,
    infill_density: 15,
    supports: false,
    ...options,
  };
  const res = await request.post(`${API}/uploads/${uploadId}/slice-plate`, {
    data,
    timeout: 120_000,
  });
  expect(res.ok()).toBe(true);
  const job = await res.json();
  return waitForJobComplete(request, job);
}

/** Poll a job until completed or failed (max ~2 min) */
export async function waitForJobComplete(request: APIRequestContext, job: any) {
  if (job.status === 'completed') return job;
  const jobId = job.job_id;
  for (let i = 0; i < 60; i++) {
    const statusRes = await request.get(`${API}/jobs/${jobId}`, { timeout: 30_000 });
    const status = await statusRes.json();
    if (status.status === 'completed') return status;
    if (status.status === 'failed') throw new Error(`Slice failed: ${status.error || 'unknown'}`);
    await new Promise(r => setTimeout(r, 2_000));
  }
  throw new Error(`Slice timed out for job ${jobId}`);
}
