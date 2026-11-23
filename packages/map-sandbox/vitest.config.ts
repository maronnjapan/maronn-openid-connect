import { testReports } from '@maronn-openid-connect/test-reach/vitest';
import { defineConfig } from 'vitest/config';

// The tests run the built bundle (dist/sandbox.js, the one the map loads), so they read none of vite.config.ts.
export default defineConfig({
  test: {
    // MARONN_TEST_REPORTS (or MARONN_REACH=1): the JSON and JUnit reports.
    ...testReports({ root: import.meta.url }),
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The first request generates the RSA key of the OP and hashes the secrets and passwords of the premises.
    testTimeout: 60_000,
  },
});
