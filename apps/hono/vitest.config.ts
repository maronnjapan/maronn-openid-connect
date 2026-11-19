import { fileURLToPath } from 'node:url';
import { testReports } from '@maronn-openid-connect/test-reach/vitest';
import { defineConfig } from 'vitest/config';

const packages = fileURLToPath(new URL('../../packages/', import.meta.url));

export default defineConfig({
  resolve: {
    // The workspace packages resolve to their dist/ through package.json, so
    // the tests would need a build first. Point them at the sources instead,
    // as packages/experimental does for core. All three must come from src/:
    // the pipelines tell errors apart with instanceof, which fails when core
    // is loaded twice.
    alias: [
      { find: /^@maronn-openid-connect\/core$/, replacement: `${packages}core/src/index.ts` },
      {
        find: /^@maronn-openid-connect\/experimental\/(.+)$/,
        replacement: `${packages}experimental/src/$1/index.ts`,
      },
      { find: /^@maronn-openid-connect\/google-login$/, replacement: `${packages}google-login/src/index.ts` },
      {
        find: /^@maronn-openid-connect\/google-login\/sign-in$/,
        replacement: `${packages}google-login/src/sign-in.ts`,
      },
    ],
  },
  test: {
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
    // MARONN_REACH=1: the functions each test runs, kept to these roots of the
    // function catalog. MARONN_TEST_REPORTS: the JSON and JUnit reports.
    ...testReports({ root: import.meta.url, roots: ['apps/hono/src/oidc-provider', 'apps/hono/src/web', 'packages/core/src', 'packages/experimental/src', 'packages/google-login/src'] }),
  },
});
