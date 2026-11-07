import { testReports } from '@maronn-openid-connect/test-reach/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test environment
    // Edge Runtime環境（Web標準APIのみ、Node.js APIは使用不可）
    // Cloudflare Workers、Vercel Edge等と同等の環境
    environment: 'edge-runtime',

    // Globals (optional, for describe/it/expect without imports)
    globals: false,

    // Coverage settings
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/test/**',
        '**/tests/**',
      ],
    },

    // Include test files
    include: ['src/**/*.{test,spec}.{js,ts}'],
    // MARONN_REACH=1: the functions each test runs, kept to these roots of the
    // function catalog. MARONN_TEST_REPORTS: the JSON and JUnit reports.
    ...testReports({ root: import.meta.url, roots: ['packages/core/src'] }),
  },
});
