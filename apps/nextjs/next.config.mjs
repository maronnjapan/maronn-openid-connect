/**
 * The React pages of the OP render the transaction of this browser's cookie at
 * a URL that names none, so they are sent with Cache-Control: no-store, the
 * header every other screen sends (htmlResponse() in
 * app/_oidc-provider/html.ts). Next.js keeps a Cache-Control set here instead
 * of the one it sends for dynamic pages.
 */
const NO_STORE_PAGES = ['/login', '/consent', '/oidc-error'];

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return NO_STORE_PAGES.map((source) => ({
      source,
      headers: [{ key: 'Cache-Control', value: 'no-store' }],
    }));
  },
  // The build tests/e2e measures (MARONN_REACH=1, src/instrumentation.ts):
  // source maps of the server code, which the V8 coverage maps back to the
  // lines of app/ and packages/*/src, and the server code left unminified,
  // so the positions are those of the functions and V8 names them as the
  // sources do.
  ...(process.env.MARONN_REACH === '1'
    ? { experimental: { serverSourceMaps: true, serverMinification: false } }
    : {}),
};

export default nextConfig;
