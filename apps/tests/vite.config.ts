import { defineConfig } from 'vite';

// Relative asset paths: CI copies the build into the map's dist/tests/, so the
// page is served under a subpath of the map's Worker and fetches its data from
// ./data beside it. JSX follows tsconfig (react-jsx).
export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
