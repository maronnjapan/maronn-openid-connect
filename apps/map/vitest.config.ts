import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The page's pure parts (src/lib) and the scripts that build its data (scripts/).
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
  },
});
