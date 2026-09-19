import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // core のソースを直接解決する。workspace リンクは package.json の
      // main（./dist/index.js）を指すため、そのままだと core を先にビルドしないと
      // テストが起動しない（ルートの test:ci はビルドを挟まない）。
      '@maronn-openid-connect/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // core / experimental は Edge Runtime 環境（Web 標準 API のみ）でテストするが、
    // このパッケージは ID トークンの検証を Google 公式の google-auth-library に委ねており、
    // 同ライブラリが Node.js の API（http / crypto など）を前提にするため Node 環境でテストする。
    environment: 'node',
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
