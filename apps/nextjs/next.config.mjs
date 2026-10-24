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
};

export default nextConfig;
