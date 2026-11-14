/**
 * The steps of the token endpoint on the in-process targets: they register
 * clients and store authorization codes on the stores of the scenario, send
 * token requests to the endpoint, and read the stores back.
 */
import { expect } from '@playwright/test';
import { createBdd, type DataTable } from 'playwright-bdd';
import {
  IN_PROCESS_TARGETS,
  authorizationCodeFields,
  requestToken,
  s256Challenge,
  scenarioClient,
  test,
  type InProcessOp,
} from '../support/in-process.js';
import { jsonBody, lastResponse, type Exchange } from '../support/target.js';

const { Given, When, Then } = createBdd(test, { tags: IN_PROCESS_TARGETS });

// Columns: client_id, client_secret, redirect_uri, and token_endpoint_auth_method
// (client_secret_basic when absent), grant_types and scope (both separated by
// spaces). Without grant_types the clients may use the authorization_code and
// refresh_token grants; without scope they register no scope list.
Given('a registered confidential client:', async ({ op }, table: DataTable) => {
  for (const row of table.hashes()) {
    const authMethod = row.token_endpoint_auth_method ?? 'client_secret_basic';
    if (authMethod !== 'client_secret_basic' && authMethod !== 'client_secret_post') {
      throw new Error(`A confidential client authenticates with client_secret_basic or client_secret_post, not ${authMethod}`);
    }
    const client = {
      clientId: requiredCell(row, 'client_id'),
      clientSecret: requiredCell(row, 'client_secret'),
      redirectUri: requiredCell(row, 'redirect_uri'),
      authMethod,
      ...(row.grant_types === undefined ? {} : { grantTypes: row.grant_types.split(' ') }),
      ...(row.scope === undefined ? {} : { scope: row.scope.split(' ') }),
    } as const;
    await op.driver.registerClient(client);
    op.clients.set(client.clientId, { ...client, presentedSecret: client.clientSecret });
  }
});

Given('the client {string} has the authorization code {string}', async ({ op }, clientId: string, code: string) => {
  await storeCode(op, clientId, code, {});
});

// One row; columns (each optional): scope, code_verifier. The code is stored
// with the S256 code_challenge of the code_verifier (RFC 7636 §4.2).
Given('the client {string} has the authorization code {string}:', async ({ op }, clientId: string, code: string, table: DataTable) => {
  const rows = table.hashes();
  const [row] = rows;
  if (row === undefined || rows.length !== 1) throw new Error('The table of an authorization code has one row');
  await storeCode(op, clientId, code, row);
});

Given('the client {string} presents invalid credentials', async ({ op }, clientId: string) => {
  scenarioClient(op, clientId).presentedSecret = 'wrong-secret';
});

Given('the client {string} has redeemed the authorization code {string}', async ({ op, exchange }, clientId: string, code: string) => {
  await redeem(op, exchange, clientId, code, authorizationCodeFields(op, clientId, code));
  expect(lastResponse(exchange).status, 'redeeming the code the first time').toBe(200);
});

When('the client {string} requests the token endpoint with grant_type {string}', async ({ op, exchange }, clientId: string, grantType: string) => {
  await requestToken(op, exchange, clientId, { grant_type: grantType });
});

// One row: the form fields of the request besides grant_type.
When('the client {string} requests the token endpoint with grant_type {string}:', async ({ op, exchange }, clientId: string, grantType: string, table: DataTable) => {
  const rows = table.hashes();
  const [row] = rows;
  if (row === undefined || rows.length !== 1) throw new Error('The table of a token request has one row of form fields');
  await requestToken(op, exchange, clientId, { grant_type: grantType, ...row });
});

// A complete authorization_code request: the code, the registered redirect_uri,
// and the code_verifier of the code when it has one.
When('the client {string} redeems the authorization code {string}', async ({ op, exchange }, clientId: string, code: string) => {
  await redeem(op, exchange, clientId, code, authorizationCodeFields(op, clientId, code));
});

When('the client {string} redeems the authorization code {string} without {word}', async ({ op, exchange }, clientId: string, code: string, parameter: string) => {
  const fields = authorizationCodeFields(op, clientId, code);
  if (!(parameter in fields)) throw new Error(`The request to redeem "${code}" has no ${parameter} to leave out`);
  delete fields[parameter];
  await redeem(op, exchange, clientId, code, fields);
});

// OAuth 2.1 §4.1.2: a code is marked used once redeemed; a request refused before that leaves it as it was.
Then('the authorization code {string} is not consumed', async ({ op }, code: string) => {
  expect(await op.driver.authorizationCodeUsed(code)).toBe(false);
});

// OAuth 2.1 §4.1.2: a replayed code revokes the tokens issued from it.
Then('the tokens issued from the authorization code {string} are revoked', async ({ op }, code: string) => {
  const issued = op.codes.get(code);
  if (issued?.accessToken === undefined) throw new Error(`The scenario redeemed no tokens from "${code}"`);
  expect(await op.driver.holdsAccessToken(issued.accessToken)).toBe(false);
  if (issued.refreshToken !== undefined) expect(await op.driver.holdsRefreshToken(issued.refreshToken)).toBe(false);
});

/**
 * Stores an authorization code issued to the client, for the scope of the row
 * (openid when absent) and with the S256 challenge of its code_verifier.
 */
async function storeCode(op: InProcessOp, clientId: string, code: string, row: Record<string, string>): Promise<void> {
  const client = scenarioClient(op, clientId);
  const codeVerifier = row.code_verifier;
  await op.driver.storeAuthorizationCode({
    code,
    clientId,
    redirectUri: client.redirectUri,
    scope: (row.scope ?? 'openid').split(' '),
    ...(codeVerifier === undefined ? {} : { codeChallenge: await s256Challenge(codeVerifier) }),
  });
  op.codes.set(code, { clientId, ...(codeVerifier === undefined ? {} : { codeVerifier }) });
}

/** Sends the token request for the code and keeps the tokens a 200 returns, for the steps that check them later. */
async function redeem(
  op: InProcessOp,
  exchange: Exchange,
  clientId: string,
  code: string,
  fields: Record<string, string>,
): Promise<void> {
  await requestToken(op, exchange, clientId, fields);
  if (lastResponse(exchange).status !== 200) return;
  const body = jsonBody(exchange);
  const known = op.codes.get(code) ?? { clientId };
  op.codes.set(code, {
    ...known,
    ...(typeof body.access_token === 'string' ? { accessToken: body.access_token } : {}),
    ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
  });
}

/**
 * The value of a cell of a table row.
 *
 * @throws {Error} when the row has no such column or the cell is empty
 */
function requiredCell(row: Record<string, string>, column: string): string {
  const value = row[column];
  if (value === undefined || value === '') throw new Error(`The table needs a ${column} column`);
  return value;
}
