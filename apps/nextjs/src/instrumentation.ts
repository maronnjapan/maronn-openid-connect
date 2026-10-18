/**
 * Next.js calls register() once when a server instance starts, before it
 * handles a request (https://nextjs.org/docs/app/guides/instrumentation).
 * This app registers its clients and development users there
 * (dev-data.ts).
 */
export async function register(): Promise<void> {
  // The database (node:sqlite) and the password hashing run on Node.js only.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { registerDevelopmentData } = await import('./dev-data');
  await registerDevelopmentData();
}
