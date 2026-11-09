/**
 * The steps of the authorization code flow on the http target: the browser
 * goes through /authorize, the login page and the consent page of the running
 * OP, and the client redeems the code at /token over HTTP.
 */
import { createHash, randomBytes } from 'node:crypto';
import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { HTTP_TARGETS, basicAuthorization, e2eClient, issuerOf, test, type BrowserFlow } from '../support/http.js';

const { Given, When } = createBdd(test, { tags: HTTP_TARGETS });

// The user is one the OP already has (the development user of the apps); the
// step only tells the later steps who logs in.
Given('the user {string} can log in with the password {string}', async ({ flow }, username: string, password: string) => {
  flow.user = { username, password };
});

// OIDC Core 1.0 §3.1.2.1 with PKCE (RFC 7636 §4.3). prompt=consent makes the OP
// show the consent page even when the user consented to the client before.
When('the client {string} sends an authorization request with scope {string}', async ({ page, baseURL, flow }, clientId: string, scope: string) => {
  const client = e2eClient(clientId);
  const codeVerifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  const url = new URL('/authorize', issuerOf(baseURL));
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    scope,
    state,
    nonce: randomBytes(16).toString('base64url'),
    code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'consent',
  }).toString();
  flow.authorization = { client, state, codeVerifier };
  await page.goto(url.toString());
});

When('the user logs in on the login page', async ({ page, flow }) => {
  const user = flow.user;
  if (user === undefined) throw new Error('The scenario names no user: add "Given the user ... can log in with the password ..."');
  await expect(page).toHaveURL(/\/login\?transaction_id=[^&]+$/);
  await page.getByLabel('Username:').fill(user.username);
  await page.getByLabel('Password:').fill(user.password);
  await page.getByRole('button', { name: 'Login' }).click();
});

// RFC 6749 §4.1.2: the OP redirects to the redirect URI with the code and the state.
When('the user approves on the consent page', async ({ page, flow }) => {
  const authorization = requiredAuthorization(flow);
  await expect(page).toHaveURL(/\/consent\?transaction_id=[^&]+$/);
  await page.getByRole('button', { name: 'Approve' }).click();
  const redirect = new URL(authorization.client.redirectUri);
  await page.waitForURL((url) => url.origin === redirect.origin && url.pathname === redirect.pathname);
  const callback = new URL(page.url());
  expect(callback.searchParams.get('state')).toBe(authorization.state);
  const code = callback.searchParams.get('code');
  if (code === null) throw new Error(`The OP redirected without a code: ${callback.toString()}`);
  flow.code = code;
});

// RFC 6749 §4.1.3 with client_secret_basic and the code_verifier (RFC 7636 §4.5).
When('the client redeems the authorization code for tokens', async ({ request, baseURL, flow, exchange }) => {
  const authorization = requiredAuthorization(flow);
  if (flow.code === undefined) throw new Error('The scenario has no authorization code: the user must approve on the consent page first');
  const response = await request.post(`${issuerOf(baseURL)}/token`, {
    headers: { Authorization: basicAuthorization(authorization.client.clientId, authorization.client.clientSecret) },
    form: {
      grant_type: 'authorization_code',
      code: flow.code,
      redirect_uri: authorization.client.redirectUri,
      code_verifier: authorization.codeVerifier,
    },
  });
  exchange.response = { status: response.status(), headers: response.headers(), body: await response.text() };
});

/**
 * The authorization request the scenario sent.
 *
 * @throws {Error} when the scenario has sent none
 */
function requiredAuthorization(flow: BrowserFlow): NonNullable<BrowserFlow['authorization']> {
  if (flow.authorization === undefined) throw new Error('The scenario sent no authorization request: add "When the client ... sends an authorization request ..."');
  return flow.authorization;
}
