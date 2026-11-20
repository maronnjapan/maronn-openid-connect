/**
 * The recorder of the HTTP exchanges of the API tests, for a measured run
 * (MARONN_REACH=1): vitest.config.ts names this setup file to testReports()
 * (option `exchanges`), which adds it only when the reach is measured, so
 * `pnpm test` never loads it.
 *
 * The tests send their requests with `app.request(url, init)`, an instance
 * field of Hono, so the class itself is replaced: every Hono the app and the
 * tests make records the requests sent to it (packages/test-reach/src/exchanges.js).
 * The mock is declared here, inside the app, because Vitest does not apply the
 * `vi.mock` of a setup file outside it.
 */
import { vi } from 'vitest';

vi.mock('hono', async (importOriginal) => {
  const { recordingHono } = await import('@maronn-openid-connect/test-reach/exchanges');
  return recordingHono(await importOriginal<typeof import('hono')>());
});
