import { testReports } from '@maronn-openid-connect/test-reach/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // MARONN_TEST_REPORTS (or MARONN_REACH=1): the JSON and JUnit reports.
    ...testReports({ root: import.meta.url }),
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The tests that read the repository start the TypeScript server and read every test file once.
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
