import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { developmentUsers } from '../../../../apps/hono/src/oidc-provider/development.js';
import { TEST_ISSUER } from '../../../../apps/hono/src/test-support/context.js';
import { CLIENT_ID, CLIENT_SECRET, NOW, REDIRECT_URI } from '../../../../apps/hono/src/test-support/token.js';
import type * as Api from '../api.js';

// The OP as the map loads it: the bundle `vite build` wrote (the test script builds it first).
const { PREMISES, SAMPLED_ENDPOINTS, candidateRequests, runRequest } = (await import(new URL('../../dist/sandbox.js', import.meta.url).href)) as typeof Api;

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

  it('should give the clock back after the request', async () => {
    await runRequest(EXCHANGE_CODE);

    expect(Date.now()).not.toBe(PREMISES.now * 1000);
    expect(new Date().getTime()).not.toBe(PREMISES.now * 1000);
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
