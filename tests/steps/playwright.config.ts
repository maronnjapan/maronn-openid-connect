/**
 * The in-process targets of the feature files (tests/features): each app's OP
 * in the worker process on in-memory stores, with no browser and no server, as
 * the API tests of the apps run it. The http target runs with the E2E specs
 * (the `http` project of tests/e2e/playwright.config.ts).
 *
 * bddgen writes the tests of each project into .features-gen/<project>
 * (generated on every run, never committed). A project generates the scenarios
 * of its tag only, and a scenario whose steps do not serve the target fails the
 * generation (support/in-process.ts, support/http.ts).
 *
 * Run: pnpm run test:features (pnpm --filter @maronn-openid-connect/test-steps test).
 */
import { defineConfig } from '@playwright/test';
import { defineBddProject } from 'playwright-bdd';
import type { InProcessOptions } from './support/in-process.js';

/** The feature files and the step definitions, the same for every target (tests/e2e/playwright.config.ts has the same). */
const bdd = {
  features: '../features/**/*.feature',
  featuresRoot: '../features',
  steps: ['support/*.ts', 'common/*.steps.ts', 'in-process/*.steps.ts', 'http/*.steps.ts'],
};

/**
 * The reports the map reads (packages/test-catalog run.ts) under MARONN_TEST_REPORTS, when a run writes them:
 * the results of both projects in one file, each test's target in its project's name.
 */
const reports = process.env['MARONN_TEST_REPORTS'] ?? (process.env['MARONN_REACH'] === '1' ? new URL('../../work/test-reports', import.meta.url).pathname : undefined);

export default defineConfig<object, InProcessOptions>({
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [
    ['list'],
    ...(reports === undefined
      ? []
      : ([
          ['json', { outputFile: `${reports}/playwright/in-process.json` }],
          ['junit', { outputFile: `${reports}/junit/features-in-process.xml` }],
        ] as const)),
  ],
  projects: [
    {
      ...defineBddProject({ name: 'in-process-hono', ...bdd, tags: '@hono' }),
      use: { target: 'hono' },
    },
    {
      ...defineBddProject({ name: 'in-process-nextjs', ...bdd, tags: '@nextjs' }),
      use: { target: 'nextjs' },
    },
  ],
});
