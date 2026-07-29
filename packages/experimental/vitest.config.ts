import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // packages/core と同じ Edge Runtime 環境（Web標準APIのみ）でテストする。
    // Experimental 機能も Portability の方針（どこでも動く）から外れないことを保証する。
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
  },
});
