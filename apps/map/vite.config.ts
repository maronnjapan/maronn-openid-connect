import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Relative asset paths, so the built page works at the root of a Worker, under a
// subpath, and opened from a directory alike. JSX follows tsconfig (react-jsx).
// Two pages: the map (index.html) and the code page (code/index.html, served at code/).
export default defineConfig({
  base: './',
  // The sandbox OP shared with the tests viewer runs in a module worker.
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: { map: fileURLToPath(new URL('./index.html', import.meta.url)), code: fileURLToPath(new URL('./code/index.html', import.meta.url)) } },
  },
});
