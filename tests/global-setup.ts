import fs from 'fs';
import path from 'path';
import { API } from './helpers';

const BASELINE_FILE = path.join(__dirname, '.test-baseline');

/**
 * Playwright global setup — runs once before all tests start.
 * Records the current max upload ID so the teardown only deletes
 * uploads created during the test run (preserving user data).
 */
export default async function globalSetup() {
  let maxId = 0;
  try {
    const res = await fetch(`${API}/upload?limit=1&offset=0`);
    if (res.ok) {
      const body = await res.json();
      const uploads = body.uploads || [];
      if (uploads.length > 0) {
        maxId = uploads[0].upload_id; // list is sorted by uploaded_at DESC
      }
    }
  } catch {
    // Services might not be up yet; baseline 0 means clean all test uploads
  }
  fs.writeFileSync(BASELINE_FILE, String(maxId));
}
