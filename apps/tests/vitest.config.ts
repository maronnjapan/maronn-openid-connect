import { testReports } from '@maronn-openid-connect/test-reach/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // MARONN_TEST_REPORTS (or MARONN_REACH=1): the JSON and JUnit reports.
    ...testReports({ root: import.meta.url }),
    // The page's pure parts (src/lib); the components are checked by looking at the page.
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
