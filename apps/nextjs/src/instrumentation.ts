/**
 * Next.js calls register() once when a server instance starts, before it
 * handles a request (https://nextjs.org/docs/app/guides/instrumentation).
 * This app registers its clients and development users there
 * (dev-data.ts).
 */
export async function register(): Promise<void> {
  // The database (node:sqlite) and the password hashing run on Node.js only.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // tests/e2e with MARONN_REACH=1 measures what each test runs in this
  // process, from before the first route is loaded. The package is resolved
  // at run time, never bundled.
  if (process.env['MARONN_REACH'] === '1') {
    const { startReach } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ '@maronn-openid-connect/test-reach/op');
    await startReach({ target: 'nextjs', accessLog: true });
  }
  const { registerDevelopmentData } = await import('./dev-data');
  await registerDevelopmentData();
}
