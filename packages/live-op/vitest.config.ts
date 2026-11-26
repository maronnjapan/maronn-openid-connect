import { testReports } from '@maronn-openid-connect/test-reach/vitest';
import { defineConfig } from 'vitest/config';

// The tests run the built bundle (dist/live-op.js and dist/node.js, the ones a host loads), so they read none of vite.config.ts.
export default defineConfig({
  test: {
    // MARONN_TEST_REPORTS (or MARONN_REACH=1): the JSON and JUnit reports.
    ...testReports({ root: import.meta.url }),
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // A workspace generates the RSA key of its OP and hashes the passwords of the development users when it opens.
    testTimeout: 60_000,
  },
});
