import { defineConfig } from 'vitest/config';
import { testReports } from './src/vitest.js';

export default defineConfig({
  test: {
    include: ['src/**/*.test.js'],
    environment: 'node',
    // MARONN_TEST_REPORTS (or MARONN_REACH=1): the JSON and JUnit reports.
    ...testReports({ root: import.meta.url }),
  },
});
