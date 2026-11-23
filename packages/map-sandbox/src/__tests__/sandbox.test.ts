import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { developmentUsers } from '../../../../apps/hono/src/oidc-provider/development.js';
import { TEST_ISSUER } from '../../../../apps/hono/src/test-support/context.js';
import { CLIENT_ID, CLIENT_SECRET, NOW, REDIRECT_URI } from '../../../../apps/hono/src/test-support/token.js';
import type * as Api from '../api.js';

// The OP as the map loads it: the bundle `vite build` wrote (the test script builds it first).
const { PREMISES, SAMPLED_ENDPOINTS, candidateRequests, preparePremises, runRequest } = (await import(new URL('../../dist/sandbox.js', import.meta.url).href)) as typeof Api;

const PIPELINE = 'apps/hono/src/oidc-provider/endpoints/token/pipeline.ts';

/** The headers of a form posted to the token endpoint by client-1 with client_secret_basic, with another secret when given. */
function tokenHeaders(secret = 'client-1-secret-value'): Array<[string, string]> {
  return [
    ['content-type', 'application/x-www-form-urlencoded'],
    ['authorization', `Basic ${btoa(`client-1:${secret}`)}`],
  ];
}

/** The authorization_code grant of code-1 of the premises, with its PKCE verifier. */
const EXCHANGE_CODE: Api.SandboxRequest = {
  method: 'POST',
  path: '/token',
  headers: tokenHeaders(),
  body: new URLSearchParams({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: 'https://rp.example.com/callback', code_verifier: 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz' }).toString(),
};

/** The line of a file of the repository that holds a piece of code. */
function lineOf(path: string, code: string): number {
  return readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8').split('\n').findIndex((line) => line.includes(code)) + 1;
}

/** The claims of a JWS compact serialization, unverified. */
function claimsOf(jwt: string): Record<string, unknown> {
  return JSON.parse(atob((jwt.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
}

describe('runRequest', () => {
  it('should answer the authorization_code grant of code-1 with a token response issued at the clock of the premises', async () => {
    const run = await runRequest(EXCHANGE_CODE);
    const body = JSON.parse(run.response?.body ?? '{}') as { access_token: string; token_type: string; refresh_token?: string };

    expect(run.response?.status).toBe(200);
    expect(body.token_type).toBe('Bearer');
    expect(claimsOf(body.access_token)).toMatchObject({ iss: 'https://op.example.com', sub: 'user-1', client_id: 'client-1', iat: PREMISES.now });
    expect(body.refresh_token).toEqual(expect.any(String));
  });

  it('should count what ran by repository path, at the lines of the original source', async () => {
    const run = await runRequest(EXCHANGE_CODE);

    expect(Object.keys(run.ran).filter((path) => path.startsWith('/') || !/\.tsx?$/.test(path))).toEqual([]);
    expect(run.ran[PIPELINE]?.s.map(([line]) => line)).toContain(lineOf(PIPELINE, 'await parseTokenRequest(c)'));
    expect(run.ran[PIPELINE]?.b).toContainEqual([lineOf(PIPELINE, 'if (clientCredentialsResponse) return'), 4, 'if', [0, 1]]);
  });

  it('should note the records the exchange read (its client and its code) and those it wrote (the code used, the tokens issued)', async () => {
    const run = await runRequest(EXCHANGE_CODE);
    const body = JSON.parse(run.response?.body ?? '{}') as { access_token: string; refresh_token: string };

    expect(run.store.read).toEqual([
      { collection: 'clients', key: CLIENT_ID, found: true },
      { collection: 'codes', key: 'code-1', found: true },
    ]);
    expect(run.store.wrote.map(({ collection, key, change, fields }) => ({ collection, key, change, fields }))).toEqual([
      { collection: 'codes', key: 'code-1', change: 'changed', fields: ['used'] },
      { collection: 'accessTokens', key: body.access_token, change: 'added', fields: undefined },
      { collection: 'refreshTokens', key: body.refresh_token, change: 'added', fields: undefined },
    ]);
  });

  it('should note a code the OP does not hold as a record read and not found, and no record written', async () => {
    const run = await runRequest({ ...EXCHANGE_CODE, body: EXCHANGE_CODE.body?.replace('code=code-1', 'code=code-9') });

    expect(run.response?.status).toBe(400);
    expect(run.store).toEqual({ read: [{ collection: 'clients', key: CLIENT_ID, found: true }, { collection: 'codes', key: 'code-9', found: false }], wrote: [] });
  });

  it('should find the premises as they are in every request, the code a request exchanged included', async () => {
    const first = await runRequest(EXCHANGE_CODE);
    const second = await runRequest(EXCHANGE_CODE);
    const refreshed = await runRequest({ method: 'POST', path: '/token', headers: tokenHeaders(), body: 'grant_type=refresh_token&refresh_token=refresh-1' });

    expect([first.response?.status, second.response?.status, refreshed.response?.status]).toEqual([200, 200, 200]);
  });

  it('should run requests asked for together one after another, each on the premises as they are', async () => {
    const runs = await Promise.all([runRequest(EXCHANGE_CODE), runRequest(EXCHANGE_CODE), runRequest({ ...EXCHANGE_CODE, headers: tokenHeaders('another-secret') })]);

    expect(runs.map((run) => run.response?.status)).toEqual([200, 200, 401]);
  });

  it('should answer a request the premises do not let through with the OAuth error of the OP', async () => {
    const run = await runRequest({ ...EXCHANGE_CODE, headers: tokenHeaders('another-secret') });

    expect(run.response?.status).toBe(401);
    expect(JSON.parse(run.response?.body ?? '{}')).toMatchObject({ error: 'invalid_client' });
  });

  it('should give the clock and the fetch of the global scope back after the request', async () => {
    const fetchBefore = globalThis.fetch;
    await runRequest(EXCHANGE_CODE);

    expect(Date.now()).not.toBe(PREMISES.now * 1000);
    expect(new Date().getTime()).not.toBe(PREMISES.now * 1000);
    expect(globalThis.fetch).toBe(fetchBefore);
  });

  it('should refuse a request that cannot be made', async () => {
    await expect(runRequest({ method: 'GET', path: '/token', headers: [], body: 'grant_type=authorization_code' })).rejects.toThrow(TypeError);
  });
});

describe('PREMISES', () => {
  it('should hold the issuer, the clock, client-1 and the users of the tests', () => {
    const client = PREMISES.clients.find((candidate) => candidate.clientId === CLIENT_ID);

    expect([PREMISES.issuer, PREMISES.now]).toEqual([TEST_ISSUER, NOW]);
    expect(client).toMatchObject({ clientSecret: CLIENT_SECRET, redirectUris: [REDIRECT_URI], authMethod: 'client_secret_basic' });
    expect(PREMISES.users).toEqual(developmentUsers.map((user) => ({ username: user.sub, password: user.password })));
    expect(PREMISES.codes.map((code) => [code.code, code.clientId, code.used === true])).toEqual([
      ['code-1', CLIENT_ID, false],
      ['code-2', CLIENT_ID, false],
      ['code-used', CLIENT_ID, true],
    ]);
  });
});

describe('candidateRequests', () => {
  it('should try the requests a client sends first, then each changed in one place, each once, at the token endpoint alone', () => {
    const requests = candidateRequests('token');

    expect(SAMPLED_ENDPOINTS).toEqual(['token']);
    expect(requests[0]).toEqual(EXCHANGE_CODE);
    expect(new Set(requests.map((request) => JSON.stringify(request))).size).toBe(requests.length);
    expect(requests.filter((request) => request.method !== 'POST' || request.path !== '/token')).toEqual([]);
    expect(requests.map((request) => request.body)).toContain('grant_type=authorization_code&redirect_uri=https%3A%2F%2Frp.example.com%2Fcallback&code_verifier=verifier-0123456789-abcdefghijklmnopqrstuvwxyz');
    expect(candidateRequests('userinfo')).toEqual([]);
  });

  it('should find a code that was exchanged already, and a client that is not the one of a code, among the requests the OP answers with their errors', async () => {
    const requests = candidateRequests('token');
    const used = requests.find((request) => request.body?.includes('code=code-used') === true);
    const otherClient = requests.find((request) => request.body?.includes('code=code-1') === true && request.body.includes('client_id=client-2&client_secret=client-2-secret-value'));
    const answers = await Promise.all([used, otherClient].map(async (request) => (request === undefined ? undefined : JSON.parse((await runRequest(request)).response?.body ?? '{}'))));

    expect(answers).toEqual([expect.objectContaining({ error: 'invalid_grant' }), expect.objectContaining({ error: 'invalid_grant' })]);
  });
});

/** The request of a step: its method and its path with the query, on the issuer of the premises. */
function lineOfStep(step: Api.PremiseStep): string {
  const url = new URL(step.request.url);
  return `${step.request.method} ${url.pathname}`;
}

/** A header of a message of a step; undefined without it. */
function headerOf(message: { headers: Array<[string, string]> }, name: string): string | undefined {
  return message.headers.find(([candidate]) => candidate === name)?.[1];
}

/** A request to the token endpoint by client-1 (client_secret_basic) with a form of fields. */
function tokenRequest(fields: Record<string, string>): Api.SandboxRequest {
  return { method: 'POST', path: '/token', headers: tokenHeaders(), body: new URLSearchParams(fields).toString() };
}

/** An RS256 key other than the one the premises were made with, under the same key id, as the JWKs the premises give one in. */
async function anotherSigningKey(keyId: string): Promise<Api.PreparedPremises['signingKey']> {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { keyId, privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey), publicJwk: { ...publicJwk, kid: keyId, alg: 'RS256', use: 'sig' } as JsonWebKey };
}

/** Whether the RS256 signature of a JWS verifies with a public JWK. */
async function verifies(token: string, publicJwk: JsonWebKey): Promise<boolean> {
  const [header = '', payload = '', signature = ''] = token.split('.');
  const key = await crypto.subtle.importKey('jwk', { kty: publicJwk.kty, n: publicJwk.n, e: publicJwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes, new TextEncoder().encode(`${header}.${payload}`));
}

/** The premises made by requests, made once for the tests that read them, as the page gets them (through JSON). */
let prepared: Promise<Api.PreparedPremises> | undefined;

/** The premises made by requests (see `prepared`). */
function premisesMade(): Promise<Api.PreparedPremises> {
  prepared ??= preparePremises().then((premises) => JSON.parse(JSON.stringify(premises)) as Api.PreparedPremises);
  return prepared;
}

describe('preparePremises', () => {
  it('should give a code by the requests a browser sends: the authorization request, the login page and form, the consent page and form, up to the redirect back with the code', async () => {
    const premises = await premisesMade();
    const steps = premises.steps.filter((step) => step.grant === 'unused');
    const last = steps.at(-1);
    const grant = premises.grants.find((candidate) => candidate.id === 'unused');

    expect(steps.map((step) => [lineOfStep(step), step.response.status])).toEqual([
      ['GET /authorize', 302],
      ['GET /login', 200],
      ['POST /login', 302],
      ['GET /consent', 200],
      ['POST /consent', 302],
    ]);
    expect(new URLSearchParams(steps[2]?.request.body).get('username')).toBe('testuser');
    expect(headerOf(steps[2]?.request ?? { headers: [] }, 'cookie')).toMatch(/^__Host-oidc_txn=/);
    expect(new URL(headerOf(last?.response ?? { headers: [] }, 'location') ?? '').searchParams.get('code')).toBe(grant?.code);
    expect(steps[1]?.response.body).toBeUndefined();
  });

  it('should say of each record the request that added it, and of the clients and the users none', async () => {
    const premises = await premisesMade();
    const recordOf = (collection: string, key: string) => premises.records.find((record) => record.collection === collection && record.key === key);
    const unused = premises.grants.find((grant) => grant.id === 'unused');
    const added = recordOf('codes', unused?.code ?? '')?.addedBy;

    expect(added === undefined ? undefined : lineOfStep(premises.steps[added] as Api.PremiseStep)).toBe('POST /consent');
    expect(premises.steps[added ?? -1]?.wrote).toContainEqual(expect.objectContaining({ collection: 'codes', key: unused?.code, change: 'added' }));
    expect(recordOf('clients', CLIENT_ID)).toEqual({ collection: 'clients', key: CLIENT_ID, value: expect.objectContaining({ clientId: CLIENT_ID }) });
    expect(recordOf('users', 'testuser')).toEqual({ collection: 'users', key: 'testuser', value: expect.objectContaining({ claims: expect.objectContaining({ sub: 'testuser' }) }) });
    expect(premises.records.filter((record) => record.collection === 'transactions' || record.collection === 'authSessions')).toEqual([]);
  });

  it('should exchange the code of a grant exchanged, the code then used and the tokens of the exchange held', async () => {
    const premises = await premisesMade();
    const exchanged = premises.grants.find((grant) => grant.id === 'exchanged');
    const exchange = premises.steps.findIndex((step) => step.grant === 'exchanged' && lineOfStep(step) === 'POST /token');
    const code = premises.records.find((record) => record.collection === 'codes' && record.key === exchanged?.code);
    const refresh = premises.records.find((record) => record.collection === 'refreshTokens' && record.key === exchanged?.tokens?.refresh_token);

    expect(premises.steps[exchange]?.response.status).toBe(200);
    expect(code).toMatchObject({ value: { used: true, subject: 'testuser', clientId: CLIENT_ID }, changedBy: [exchange] });
    expect(refresh).toMatchObject({ addedBy: exchange, value: { used: false, scope: ['openid', 'profile', 'offline_access'] } });
  });
});

describe('preparePremises, of other grants', () => {
  it('should exchange the code of a client that sends its secret in the body (client_secret_post), as it is registered to', async () => {
    const [grant] = PREMISES.grants;
    const premises = await preparePremises({ ...PREMISES, grants: [{ ...(grant as Api.PremiseGrant), id: 'post', authorize: { ...grant?.authorize, client_id: 'client-2' }, exchange: true }] });
    const exchange = premises.steps.at(-1);

    expect([lineOfStep(exchange as Api.PremiseStep), exchange?.response.status]).toEqual(['POST /token', 200]);
    expect(new URLSearchParams(exchange?.request.body).get('client_secret')).toBe('client-2-secret-value');
    expect(headerOf(exchange?.request ?? { headers: [] }, 'authorization')).toBeUndefined();
  });

  it('should take the code from the form the OP posts back to the client (response_mode=form_post), without posting it to the OP', async () => {
    const [grant] = PREMISES.grants;
    const premises = await preparePremises({ ...PREMISES, grants: [{ ...(grant as Api.PremiseGrant), id: 'form-post', authorize: { ...grant?.authorize, response_mode: 'form_post' } }] });
    const last = premises.steps.at(-1);

    expect(premises.grants[0]?.code).toEqual(expect.any(String));
    expect(premises.records.find((record) => record.collection === 'codes')?.key).toBe(premises.grants[0]?.code);
    expect([lineOfStep(last as Api.PremiseStep), last?.response.status]).toEqual(['POST /consent', 200]);
  });

  it('should refuse to make premises whose grant the OP gives no code for', async () => {
    const [grant] = PREMISES.grants;

    await expect(preparePremises({ ...PREMISES, grants: [{ ...(grant as Api.PremiseGrant), id: 'no-pkce', authorize: { ...grant?.authorize, code_challenge: '' } }] })).rejects.toThrow('The OP did not give the code of the grant no-pkce');
  });
});

describe('runRequest on premises made by requests', () => {
  it('should exchange the code no request exchanged, and refresh with the refresh token of the exchanged one', async () => {
    const premises = await premisesMade();
    const [unused, exchanged] = premises.grants;
    const code = await runRequest(tokenRequest({ grant_type: 'authorization_code', code: unused?.code ?? '', redirect_uri: REDIRECT_URI, code_verifier: unused?.codeVerifier ?? '' }), premises);
    const refresh = await runRequest(tokenRequest({ grant_type: 'refresh_token', refresh_token: String(exchanged?.tokens?.refresh_token) }), premises);

    expect([code.response?.status, refresh.response?.status]).toEqual([200, 200]);
    expect(code.store.read).toEqual([
      { collection: 'clients', key: CLIENT_ID, found: true },
      { collection: 'codes', key: unused?.code, found: true },
    ]);
  });

  it('should refuse the code exchanged already and revoke the tokens its exchange issued', async () => {
    const premises = await premisesMade();
    const exchanged = premises.grants.find((grant) => grant.id === 'exchanged');
    const run = await runRequest(tokenRequest({ grant_type: 'authorization_code', code: exchanged?.code ?? '', redirect_uri: REDIRECT_URI, code_verifier: exchanged?.codeVerifier ?? '' }), premises);

    expect(JSON.parse(run.response?.body ?? '{}')).toMatchObject({ error: 'invalid_grant' });
    expect(run.store.wrote.map(({ collection, key, change }) => ({ collection, key, change }))).toEqual([
      { collection: 'accessTokens', key: exchanged?.tokens?.access_token, change: 'removed' },
      { collection: 'refreshTokens', key: exchanged?.tokens?.refresh_token, change: 'removed' },
    ]);
  });

  it('should take the access token of the premises at the UserInfo endpoint', async () => {
    const premises = await premisesMade();
    const exchanged = premises.grants.find((grant) => grant.id === 'exchanged');
    const run = await runRequest({ method: 'GET', path: '/userinfo', headers: [['authorization', `Bearer ${String(exchanged?.tokens?.access_token)}`]] }, premises);

    expect(run.response?.status).toBe(200);
    expect(JSON.parse(run.response?.body ?? '{}')).toMatchObject({ sub: 'testuser' });
  });

  it('should sign the tokens it issues with the key the premises give, not one of its own', async () => {
    const premises = await premisesMade();
    const other = await anotherSigningKey(premises.signingKey.keyId);
    const unused = premises.grants.find((grant) => grant.id === 'unused');
    const run = await runRequest(tokenRequest({ grant_type: 'authorization_code', code: unused?.code ?? '', redirect_uri: REDIRECT_URI, code_verifier: unused?.codeVerifier ?? '' }), { ...premises, signingKey: other });
    const { access_token: token } = JSON.parse(run.response?.body ?? '{}') as { access_token: string };

    expect(await verifies(token, other.publicJwk)).toBe(true);
    expect(await verifies(token, premises.signingKey.publicJwk)).toBe(false);
  });
});
