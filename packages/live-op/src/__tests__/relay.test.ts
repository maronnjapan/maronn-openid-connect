import { describe, expect, it } from 'vitest';
import type * as LiveOp from '../index.js';
import type * as NodeHost from '../node.js';

// The built bundles (the package script builds them first), the OP and the Node host; URLs, so the type checker leaves them to the types of the sources.
const {
  answerLive,
  EXCHANGE_HEADER,
  isLivePath,
  LIVE_PREFIX,
  LiveWorkspace,
  OP_ROUTES,
  PUBLIC_WORKSPACE,
  refusalOf,
  REQUEST_BODY_LIMIT,
  REQUEST_URL_LIMIT,
  WORKSPACE_COOKIE,
  WORKSPACE_HEADER,
  workspaceIdOf,
} = await import(new URL('../../dist/live-op.js', import.meta.url).href) as typeof LiveOp;
const { createLiveOpHost } = await import(new URL('../../dist/node.js', import.meta.url).href) as typeof NodeHost;

/** An issuer the OP's redirect URIs are valid under (an https origin). */
const ISSUER = 'https://op.example.com';

/** A request to a path of the issuer. */
function at(path: string, init: RequestInit = {}): Request {
  return new Request(new URL(path, ISSUER), init);
}

/** A control request with a JSON body. */
function control(path: string, body: unknown): Request {
  return at(`${LIVE_PREFIX}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

/** The status and the JSON body of a response. */
async function answered(response: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('answerLive', () => {
  it('should answer an OP path as the OP and name its exchange in the response', async () => {
    const workspace = await LiveWorkspace.open('relay-op', ISSUER);
    const response = await answerLive(workspace, at('/.well-known/openid-configuration'));
    const named = response.headers.get(EXCHANGE_HEADER);
    const exchange = named === null ? undefined : await workspace.exchange(named);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ issuer: ISSUER });
    expect(named).toBe(workspace.summaries().at(-1)?.id);
    expect(exchange).toMatchObject({ source: 'http', method: 'GET', path: '/.well-known/openid-configuration', status: 200 });
  });

  it('should answer a control request that cannot be done with 400 and what is wrong', async () => {
    const workspace = await LiveWorkspace.open('relay-errors', ISSUER);
    const refused = [
      await answered(await answerLive(workspace, control('run', 'not json'))),
      await answered(await answerLive(workspace, control('run', { request: { method: 'GET', path: 'token', headers: [] } }))),
      await answered(await answerLive(workspace, control('scenario', { id: 'no-such-case' }))),
      await answered(await answerLive(workspace, control('grant', { plan: { username: 'testuser' } }))),
      await answered(await answerLive(workspace, control('clock', { advanceSeconds: '600' }))),
    ];
    for (const { status, body } of refused) {
      expect(status).toBe(400);
      expect(body['error']).toBe('invalid_request');
      expect(typeof body['error_description']).toBe('string');
    }
    expect(workspace.summaries()).toEqual([]);
  });

  it('should run, list and give back the exchanges of a workspace through the control API', async () => {
    const workspace = await LiveWorkspace.open('relay-control', ISSUER);
    const prepared = await answered(await answerLive(workspace, control('scenario', { id: 'login-open-transaction' })));
    const ran = await answered(await answerLive(workspace, control('run', { request: prepared.body['request'] })));
    const listed = await (await answerLive(workspace, at(`${LIVE_PREFIX}exchanges`))).json() as LiveOp.ExchangeSummary[];
    const after = await (await answerLive(workspace, at(`${LIVE_PREFIX}exchanges?after=${String((prepared.body['steps'] as LiveOp.ExchangeSummary[])[0]?.id)}`))).json() as LiveOp.ExchangeSummary[];
    const one = await answered(await answerLive(workspace, at(`${LIVE_PREFIX}exchanges/${String(ran.body['id'])}`)));
    const missing = await answerLive(workspace, at(`${LIVE_PREFIX}exchanges/x999`));
    expect(prepared.status).toBe(200);
    expect(ran.status).toBe(200);
    expect(ran.body).toMatchObject({ source: 'relay', status: 200 });
    expect(listed.map((summary) => summary.id)).toEqual([...(prepared.body['steps'] as LiveOp.ExchangeSummary[]).map((step) => step.id), ran.body['id']]);
    expect(after).toHaveLength(listed.length - 1);
    expect(one.body['id']).toBe(ran.body['id']);
    expect((one.body['trace'] as LiveOp.TraceEvents).events.length).toBeGreaterThan(0);
    expect(missing.status).toBe(404);
  });

  it('should give the state, move the clock, reset, and serve the probe table and the callback page', async () => {
    const workspace = await LiveWorkspace.open('relay-state', ISSUER);
    await answerLive(workspace, at('/.well-known/jwks.json'));
    const state = await answered(await answerLive(workspace, at(`${LIVE_PREFIX}state`)));
    const moved = await answered(await answerLive(workspace, control('clock', { advanceSeconds: 60 })));
    const reset = await answered(await answerLive(workspace, control('reset', {})));
    const probes = await answerLive(workspace, at(`${LIVE_PREFIX}probes`));
    const table = await probes.json() as LiveOp.ProbeTable;
    const callback = await answerLive(workspace, at(`${LIVE_PREFIX}callback?code=abc%3Cdef&state=xyz`));
    const page = await callback.text();
    expect(state.body).toMatchObject({ workspace: 'relay-state', issuer: ISSUER, exchanges: 1, clockOffset: 0 });
    expect(moved.body).toMatchObject({ clockOffset: 60 });
    expect(reset.body).toMatchObject({ clockOffset: 0, exchanges: 1 });
    expect(probes.headers.get('etag')).toBe(`"${table.hash}"`);
    expect(table.probes.length).toBeGreaterThan(0);
    expect(callback.headers.get('content-type')).toContain('text/html');
    expect(page).toContain('abc&#60;def');
    expect(page).not.toContain('abc<def');
  });
});

describe('answerLive refusals', () => {
  /** A token request of client-1 with a body of some bytes. */
  function tokenRequest(bytes: number, init: RequestInit = {}): Request {
    const body = `grant_type=client_credentials&pad=${'a'.repeat(Math.max(0, bytes - 34))}`;
    return at('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, ...init });
  }

  it('should answer 413 for a body or a URL past the playground\'s limits, before the OP runs', async () => {
    const workspace = await LiveWorkspace.open('relay-limits', ISSUER);
    const within = await answerLive(workspace, tokenRequest(REQUEST_BODY_LIMIT));
    const body = await answered(await answerLive(workspace, tokenRequest(REQUEST_BODY_LIMIT + 1)));
    const chunks = [new TextEncoder().encode('grant_type=client_credentials&pad='), new Uint8Array(REQUEST_BODY_LIMIT).fill(97)];
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { const chunk = chunks.shift(); if (chunk === undefined) controller.close(); else controller.enqueue(chunk); } });
    // A body sent without a Content-Length: read up to the limit.
    const streamed = await answerLive(workspace, at('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: stream, duplex: 'half' } as RequestInit));
    const url = await answerLive(workspace, at(`/authorize?state=${'s'.repeat(REQUEST_URL_LIMIT)}`));
    const relayed = await answered(await answerLive(workspace, control('run', { request: { method: 'GET', path: `/authorize?state=${'s'.repeat(REQUEST_URL_LIMIT)}`, headers: [] } })));
    expect(within.status).toBe(401);
    expect(body.status).toBe(413);
    expect(body.body['error_description']).toContain('地図の OP（遊び場）の制限');
    expect(body.body['error_description']).toContain('OP（apps/hono）の制限ではありません');
    expect(streamed.status).toBe(413);
    expect(url.status).toBe(413);
    expect(relayed.status).toBe(413);
    expect(workspace.summaries()).toHaveLength(1);
  });

  it('should refuse a control request that changes something unless the map\'s own page could have sent it', async () => {
    const workspace = await LiveWorkspace.open('relay-csrf', ISSUER);
    await answerLive(workspace, at('/.well-known/jwks.json'));
    const post = (headers: Record<string, string>): Request => at(`${LIVE_PREFIX}reset`, { method: 'POST', headers, body: '{}' });
    const refused = [
      await answerLive(workspace, post({ 'content-type': 'text/plain' })),
      await answerLive(workspace, post({ 'content-type': 'application/x-www-form-urlencoded' })),
      await answerLive(workspace, post({})),
      await answerLive(workspace, post({ 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })),
      await answerLive(workspace, post({ 'content-type': 'application/json', 'sec-fetch-site': 'same-site' })),
      await answerLive(workspace, post({ 'content-type': 'application/json', [WORKSPACE_HEADER]: 'not a workspace!' })),
    ];
    const kept = workspace.summaries().length;
    const taken = [
      await answerLive(workspace, post({ 'content-type': 'application/json; charset=utf-8', 'sec-fetch-site': 'same-origin' })),
      await answerLive(workspace, post({ 'content-type': 'application/json', 'sec-fetch-site': 'none' })),
      await answerLive(workspace, post({ 'content-type': 'application/json' })),
    ];
    const callback = await answerLive(workspace, at(`${LIVE_PREFIX}callback?code=abc`, { headers: { 'sec-fetch-site': 'cross-site' } }));
    expect(refused.map((response) => response.status)).toEqual([415, 415, 415, 403, 403, 400]);
    expect(kept).toBe(1);
    expect(taken.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(workspace.summaries()).toEqual([]);
    expect(callback.status).toBe(200);
  });

  it('should refuse before a host finds the workspace, from the URL and the headers alone', () => {
    expect(refusalOf(at('/token', { method: 'POST', headers: { 'content-length': String(REQUEST_BODY_LIMIT + 1) } }))?.status).toBe(413);
    expect(refusalOf(at(`/authorize?state=${'s'.repeat(REQUEST_URL_LIMIT)}`))?.status).toBe(413);
    expect(refusalOf(at('/token', { headers: { [WORKSPACE_HEADER]: '../public' } }))?.status).toBe(400);
    expect(refusalOf(at(`${LIVE_PREFIX}clock`, { method: 'POST', headers: { 'content-type': 'text/plain' } }))?.status).toBe(415);
    expect(refusalOf(at(`${LIVE_PREFIX}state`, { headers: { 'sec-fetch-site': 'cross-site' } }))).toBeUndefined();
    // The OP's own paths are the OP's: a form another site posts to /token is the OP's to answer.
    expect(refusalOf(at('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' } }))).toBeUndefined();
  });
});

describe('workspaceIdOf', () => {
  it('should take the control API\'s workspace from the header only, never from the cookie', () => {
    expect(workspaceIdOf(at(`${LIVE_PREFIX}reset`, { method: 'POST', headers: { cookie: `${WORKSPACE_COOKIE}=reader_2` } }))).toBe(PUBLIC_WORKSPACE);
    expect(workspaceIdOf(at(`${LIVE_PREFIX}state`, { headers: { [WORKSPACE_HEADER]: 'reader_1', cookie: `${WORKSPACE_COOKIE}=reader_2` } }))).toBe('reader_1');
  });

  it('should read the workspace from the header, then the cookie, and fall back to the public one', () => {
    expect(workspaceIdOf(at('/token', { headers: { [WORKSPACE_HEADER]: 'reader_1' } }))).toBe('reader_1');
    expect(workspaceIdOf(at('/token', { headers: { [WORKSPACE_HEADER]: 'reader_1', cookie: `${WORKSPACE_COOKIE}=reader_2` } }))).toBe('reader_1');
    expect(workspaceIdOf(at('/token', { headers: { cookie: `other=1; ${WORKSPACE_COOKIE}=reader-2` } }))).toBe('reader-2');
    expect(workspaceIdOf(at('/token'))).toBe(PUBLIC_WORKSPACE);
  });

  it('should take a name that is not a workspace id as the public workspace', () => {
    expect(workspaceIdOf(at('/token', { headers: { [WORKSPACE_HEADER]: 'not a workspace!' } }))).toBe(PUBLIC_WORKSPACE);
    expect(workspaceIdOf(at('/token', { headers: { cookie: `${WORKSPACE_COOKIE}=../../etc` } }))).toBe(PUBLIC_WORKSPACE);
    expect(workspaceIdOf(at('/token', { headers: { [WORKSPACE_HEADER]: 'x'.repeat(65) } }))).toBe(PUBLIC_WORKSPACE);
  });
});

describe('isLivePath', () => {
  it('should take the control API and the OP\'s paths, and leave the map\'s pages', () => {
    expect(isLivePath(`${LIVE_PREFIX}state`)).toBe(true);
    expect(isLivePath('/token')).toBe(true);
    expect(isLivePath('/login/google')).toBe(true);
    expect(isLivePath('/.well-known/openid-configuration')).toBe(true);
    expect(isLivePath('/')).toBe(false);
    expect(isLivePath('/health')).toBe(false);
    expect(isLivePath('/tokens')).toBe(false);
    expect(isLivePath('/assets/index.js')).toBe(false);
  });

  it('should cover every path the server app registers, but its home page, health check and operator routes', async () => {
    const workspace = await LiveWorkspace.open('relay-routes', ISSUER);
    // A route ending in `/*` is a middleware of the path and the paths beneath it; the path itself is what a request names.
    const paths = [...new Set(workspace.routes().map((route) => route.path.replace(/\/\*$/, '')))];
    const answered = paths.filter((path) => path !== '/' && path !== '/health' && !path.startsWith('/operator'));
    expect(answered.length).toBeGreaterThan(20);
    expect(answered.filter((path) => !isLivePath(path))).toEqual([]);
    // And no pattern of OP_ROUTES names a path the app does not answer.
    expect(OP_ROUTES.filter((route) => !paths.some((path) => (route.endsWith('/*') ? path === route.slice(0, -2) || path.startsWith(route.slice(0, -1)) : path === route)))).toEqual([]);
  });
});

describe('createLiveOpHost', () => {
  it('should hand a live path to the workspace the request names and leave any other path', async () => {
    const host = createLiveOpHost({ issuer: ISSUER });
    const page = await host.fetch(new Request('http://127.0.0.1:3610/health'));
    const response = await host.fetch(new Request('http://127.0.0.1:3610/.well-known/jwks.json', { headers: { [WORKSPACE_HEADER]: 'node-host' } }));
    const workspace = await host.workspace(ISSUER, 'node-host');
    expect(page).toBeUndefined();
    expect(response?.status).toBe(200);
    expect(response?.headers.get(EXCHANGE_HEADER)).toBe('x1');
    expect(workspace.summaries().map((summary) => summary.id)).toEqual(['x1']);
    expect(await host.workspace(ISSUER, 'node-host')).toBe(workspace);
  });
});
