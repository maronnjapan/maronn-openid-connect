import { defineConfig } from 'vite';
// By its path: the tests page's package does not depend on the live OP's; Vite bundles this file with the config.
import { liveOp } from '../../packages/live-op/src/vite.ts';

// Relative asset paths: CI copies the build into the map's dist/tests/, so the
// page is served under a subpath of the map's Worker and fetches its data from
// ./data beside it. JSX follows tsconfig (react-jsx).
// The dev server and the preview answer the live OP's paths at their own origin (liveOp),
// as the map's Worker does at the origin the page is deployed to.
export default defineConfig({
  base: './',
  plugins: [liveOp()],
  worker: { format: 'es' },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
