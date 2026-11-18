import { testReports } from '@maronn-openid-connect/test-reach/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // core と同じ Edge Runtime 環境（Web 標準 API のみ）でテストする。
    // DPoP の検証は Web Crypto だけで行うので、Cloudflare Workers や Vercel Edge でも動くことをここで保証する。
    environment: 'edge-runtime',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.spec.ts',
      ],
    },
    include: ['src/**/*.{test,spec}.{js,ts}'],
    // MARONN_REACH=1: the functions each test runs, kept to these roots of the
    // function catalog. MARONN_TEST_REPORTS: the JSON and JUnit reports.
    ...testReports({ root: import.meta.url, roots: ['packages/dpop/src'] }),
  },
});
