/**
 * The test of the http target: the running OP of tests/e2e/playwright.config.ts
 * (its webServer), reached with a browser (page) and HTTP (request), as the
 * E2E specs do.
 *
 * The OP is not set up from here: a scenario uses what the E2E config gives it,
 * the registered clients (OIDC_CLIENTS_JSON) and the development user of the
 * apps (testuser / password). E2E_CLIENTS below names the clients a scenario
 * can act as.
 *
 * The steps of http/ are defined with this test and HTTP_TARGETS: a scenario
 * tagged @hono or @nextjs that uses one of them has no definition for it on
 * any target, and bddgen fails.
 */
import { test as base } from './target.js';

/** The tags of the scenarios the http steps serve: any scenario that is not also run in process. */
export const HTTP_TARGETS = 'not @hono and not @nextjs';

/** A client registered in tests/e2e/playwright.config.ts whose redirect URI nothing serves, so the steps read the code themselves. */
export interface E2eClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** What the scenario carried through the browser: the user, and the authorization request and its response. */
export interface BrowserFlow {
  user?: { username: string; password: string };
  authorization?: { client: E2eClient; state: string; codeVerifier: string };
  code?: string;
}

export const test = base.extend<{ flow: BrowserFlow }>({
  flow: async ({}, use) => {
    await use({});
  },
});

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientBaseURL = process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${process.env.E2E_CLIENT_PORT ?? '3020'}`;

/**
 * The clients a scenario can act as, by client_id: their registration in
 * tests/e2e/playwright.config.ts. Each uses client_secret_basic.
 */
const E2E_CLIENTS: Record<string, E2eClient> = {
  // The client the E2E config registers for the feature files: no spec uses
  // it, so the consent a scenario records changes no spec's flow.
  'e2e-features-client': {
    clientId: 'e2e-features-client',
    clientSecret: 'e2e-features-client-secret',
    redirectUri: `${clientBaseURL}/features-callback`,
  },
};

/**
 * The registration of a client of the E2E config.
 *
 * @throws {Error} when the steps know no such client (add it to E2E_CLIENTS with its registration)
 */
export function e2eClient(clientId: string): E2eClient {
  const client = E2E_CLIENTS[clientId];
  if (client === undefined) {
    throw new Error(`The http target knows no client "${clientId}": add its registration of tests/e2e/playwright.config.ts to E2E_CLIENTS`);
  }
  return client;
}

/**
 * The base URL of the OP the project runs against.
 *
 * @throws {Error} when the project has no baseURL
 */
export function issuerOf(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('The http target needs the baseURL of the OP (use.baseURL of tests/e2e/playwright.config.ts)');
  return baseURL;
}

/** The Authorization header of client_secret_basic (RFC 6749 §2.3.1). */
export function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
}
