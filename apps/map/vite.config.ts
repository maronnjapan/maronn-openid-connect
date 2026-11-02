import { defineConfig } from 'vite';

// Relative asset paths, so the built page works at the root of a Worker, under a
// subpath, and opened from a directory alike. JSX follows tsconfig (react-jsx).
export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
