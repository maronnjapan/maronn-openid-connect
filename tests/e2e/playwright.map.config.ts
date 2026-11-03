import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './map-specs',
  outputDir: './test-results/map',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:3611',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @maronn-openid-connect/map exec vite preview --host 127.0.0.1 --port 3611 --strictPort',
    url: 'http://127.0.0.1:3611',
    reuseExistingServer: !process.env.CI,
  },
});
