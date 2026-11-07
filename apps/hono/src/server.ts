/**
 * Start the app on Node.js: `pnpm --filter @maronn-openid-connect/app-hono start`.
 *
 * The app is imported after the measurement of tests/e2e (MARONN_REACH=1)
 * has started, so V8 counts its modules from their first line.
 */
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';

const reach = process.env['MARONN_REACH'] === '1';
if (reach) await (await import('@maronn-openid-connect/test-reach/op')).startReach({ target: 'hono' });
const { createServerApp } = await import('./app.js');
const { readServerAddress } = await import('./settings.js');

const { host, port, issuer } = readServerAddress(process.env);
const app = await createServerApp(process.env);
const served = reach ? await withAccessLog(app) : app;

serve({ fetch: served.fetch, hostname: host, port }, () => {
  console.log(`OpenID Provider listening on ${issuer}`);
});

/**
 * Put an access log of every response in front of the app for the
 * measurement of tests/e2e (MARONN_REACH_ACCESS_LOG): the requests the
 * browser does not see, the RP's back channel, are known from it. The app
 * itself still answers every request as it is.
 */
async function withAccessLog(app: Hono): Promise<Hono> {
  const accessLog = process.env['MARONN_REACH_ACCESS_LOG'];
  if (!accessLog) return app;
  const { appendFileSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const { Hono } = await import('hono');
  const { logger } = await import('hono/logger');
  mkdirSync(dirname(accessLog), { recursive: true });
  writeFileSync(accessLog, '');
  const root = new Hono();
  root.use(logger((line) => {
    // `--> GET /token 200 3ms`, its status colored unless NO_COLOR is set.
    if (line.startsWith('-->')) appendFileSync(accessLog, `${Date.now()} ${line.replace(/\x1b\[[0-9;]*m/g, '')}\n`);
  }));
  root.all('*', (c) => app.fetch(c.req.raw, c.env));
  return root;
}
