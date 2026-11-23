import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { istanbul } from './istanbul.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const packages = fileURLToPath(new URL('../', import.meta.url));
const shims = fileURLToPath(new URL('./src/shims/', import.meta.url));

// One ES module, dist/sandbox.js, that runs in a Web Worker of the map and in Node alike: the OP of apps/hono and
// everything it imports, the workspace packages from their sources (as apps/hono's tests load them, so core is
// loaded once and its errors pass instanceof), counted by Istanbul. The few Node modules the OP imports for Google
// sign-in are replaced by shims that refuse: the map's OP has no Google client.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@maronn-openid-connect\/core$/, replacement: `${packages}core/src/index.ts` },
      { find: /^@maronn-openid-connect\/experimental\/(.+)$/, replacement: `${packages}experimental/src/$1/index.ts` },
      { find: /^@maronn-openid-connect\/google-login$/, replacement: `${packages}google-login/src/index.ts` },
      { find: /^@maronn-openid-connect\/google-login\/sign-in$/, replacement: `${packages}google-login/src/sign-in.ts` },
      { find: /^google-auth-library$/, replacement: `${shims}google-auth-library.ts` },
      { find: /^node:crypto$/, replacement: `${shims}node-crypto.ts` },
    ],
  },
  plugins: [
    istanbul({
      repository,
      roots: ['apps/hono/src/oidc-provider', 'apps/hono/src/web', 'packages/core/src', 'packages/experimental/src', 'packages/google-login/src'],
    }),
  ],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'sandbox.js',
    },
  },
});
