import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The tests that read the repository start the TypeScript server and read every root once.
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
