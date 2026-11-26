import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * The end-to-end tests of the map (e2e/*.spec.ts) on the Workers runtime:
 * `wrangler dev` runs the map's own Worker (worker/index.ts) on the built
 * page (dist/), so the pages are the static assets and the live OP answers
 * at the root of the same origin, one SQLite-backed Durable Object per
 * workspace, as in production. Each test opens the map in a browser context
 * of its own, so it gets a workspace of its own.
 *
 * The page and the OP are built, not built here: run `pnpm run build:map`
 * first (CI's map job runs it in the step before). Every run starts the
 * Durable Objects empty: their storage (`--persist-to`) is under the output
 * directory, which Playwright empties before it starts the Worker. Both are
 * under .wrangler/, which git ignores.
 */

const host = '127.0.0.1';
const port = Number(process.env.MAP_E2E_PORT ?? '8787');
const baseURL = `http://${host}:${port}`;
const outputDir = '.wrangler/e2e/test-results';

for (const built of ['dist/index.html', '../../packages/live-op/dist/live-op.js']) {
  if (!existsSync(new URL(built, import.meta.url))) throw new Error(`apps/map/${built} is missing: run pnpm run build:map before the map's E2E tests`);
}

export default defineConfig({
  testDir: 'e2e',
  outputDir,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL,
    locale: 'ja-JP',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `pnpm exec wrangler dev --ip ${host} --port ${port} --persist-to ${outputDir}/worker-state --show-interactive-dev-session=false`,
    // The OP's own path: it answers once the Worker is up and a Durable Object opened the OP.
    url: `${baseURL}/.well-known/openid-configuration`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // No request to Cloudflare for the `request.cf` of local requests, and no telemetry.
      CLOUDFLARE_CF_FETCH_ENABLED: 'false',
      WRANGLER_SEND_METRICS: 'false',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 960 } },
    },
  ],
});
