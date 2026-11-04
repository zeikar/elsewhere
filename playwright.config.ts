import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

// E2E runs against `vite preview` of the e2e-mode build (dist-e2e/, which includes the test hook)
// at the /elsewhere/ base path. `npm run test:e2e` builds it first.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // Headless WebGL through SwiftShader.
          args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle'],
        },
      },
    },
  ],
  webServer: {
    command: `npx vite preview --outDir dist-e2e --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/elsewhere/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
