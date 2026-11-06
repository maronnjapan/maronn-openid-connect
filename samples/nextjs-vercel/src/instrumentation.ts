/**
 * Next.js calls register() once when a server instance starts, before it
 * handles a request (https://nextjs.org/docs/app/guides/instrumentation).
 * This sample installs its rotatable signing keys there (signing-keys.ts),
 * before anything loads the generated provider.ts, and registers its clients
 * and development users (sample-data.ts).
 */
export async function register(): Promise<void> {
  // The database (node:sqlite) and the password hashing run on Node.js only.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { installSigningKeys } = await import('./signing-keys');
  installSigningKeys();
  const { registerSampleData } = await import('./sample-data');
  await registerSampleData();
}
