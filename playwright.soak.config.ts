import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// The long-run soak (`npm run soak`, e2e/soak/): the same browser, flags and preview server as the
// e2e suite, one test at a time, no retries (a soak that needs a retry has found something). Its
// length comes from SOAK_MINUTES (default 30); see e2e/soak/soak.spec.ts.
export default defineConfig({
  ...base,
  testDir: 'e2e/soak',
  testIgnore: [],
  fullyParallel: false,
  workers: 1,
  retries: 0,
});
