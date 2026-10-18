/**
 * Start the app on Node.js: `pnpm --filter @maronn-openid-connect/app-hono start`.
 */
import { serve } from '@hono/node-server';
import { createServerApp } from './app.js';
import { readServerAddress } from './settings.js';

const { host, port, issuer } = readServerAddress(process.env);
const app = await createServerApp(process.env);

serve({ fetch: app.fetch, hostname: host, port }, () => {
  console.log(`OpenID Provider listening on ${issuer}`);
});
