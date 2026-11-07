import { testReports } from '@maronn-openid-connect/test-reach/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    // MARONN_TEST_REPORTS (or MARONN_REACH=1): the JSON and JUnit reports.
    ...testReports({ root: import.meta.url }),
  },
});
