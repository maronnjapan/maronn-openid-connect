import { describe, expect, it } from 'vitest';
import type * as LiveOp from '../index.js';

// The built bundle (the package script builds it first), the OP a host runs; a URL, so the type checker leaves it to the types of the sources.
const { LiveWorkspace, MAX_EXCHANGES, MemoryStorage, oauthErrorOf, prepareRecipe, probeTable, PUBLIC_WORKSPACE, RECIPES, RP_CALLBACK, runGrant } = await import(new URL('../../dist/live-op.js', import.meta.url).href) as typeof LiveOp;

/** An issuer the OP's redirect URIs are valid under (an https origin). */
const ISSUER = 'https://op.example.com';

/** The secret client-1 is configured with (seed.ts). */
const CLIENT_1_BASIC = `Basic ${btoa('client-1:client-1-secret-value')}`;

/** Bytes as base64url without padding. */
function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The authorization of client-1 for testuser with a fresh PKCE pair, its code exchanged or not. */
async function client1Grant(exchange: boolean): Promise<LiveOp.GrantPlan> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return {
    authorize: { response_type: 'code', client_id: 'client-1', redirect_uri: RP_CALLBACK, scope: 'openid profile', state: base64Url(crypto.getRandomValues(new Uint8Array(8))), code_challenge: challenge, code_challenge_method: 'S256' },
    codeVerifier: verifier,
    username: 'testuser',
    exchange,
  };
}

/** The kid in the header of a JWT (RFC 7515 §4.1.4). */
function keyIdOf(jwt: unknown): unknown {
  const [header = ''] = String(jwt).split('.');
  return (JSON.parse(atob(header.replace(/-/g, '+').replace(/_/g, '/'))) as { kid?: unknown }).kid;
}

/** The token request of client-1 that exchanges the code of a grant. */
function codeExchange(grant: LiveOp.GrantResult): LiveOp.LiveRequest {
  return {
    method: 'POST',
    path: '/token',
    headers: [['content-type', 'application/x-www-form-urlencoded'], ['authorization', CLIENT_1_BASIC]],
    body: new URLSearchParams({ grant_type: 'authorization_code', code: grant.code ?? '', redirect_uri: grant.redirectUri, code_verifier: grant.codeVerifier ?? '' }).toString(),
  };
}

/** A request for the OP's metadata, the cheapest one it answers. */
const DISCOVERY: LiveOp.LiveRequest = { method: 'GET', path: '/.well-known/openid-configuration', headers: [] };

/** A request for the OP's public keys. */
const JWKS: LiveOp.LiveRequest = { method: 'GET', path: '/.well-known/jwks.json', headers: [] };

/** A PKCE challenge of RFC 7636 Appendix B, for a request whose code is never exchanged. */
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

/** A pushed authorization request of client-1 (RFC 9126 §2.1), with a state of some length. */
function pushed(stateLength = 16): LiveOp.LiveRequest {
  return {
    method: 'POST',
    path: '/par',
    headers: [['content-type', 'application/x-www-form-urlencoded'], ['authorization', CLIENT_1_BASIC]],
    body: new URLSearchParams({ response_type: 'code', redirect_uri: RP_CALLBACK, scope: 'openid', code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 's'.repeat(stateLength) }).toString(),
  };
}

/** A registration of a public client of the code flow (RFC 7591 §3.1). */
const REGISTRATION: LiveOp.LiveRequest = {
  method: 'POST',
  path: '/register',
  headers: [['content-type', 'application/json']],
  body: JSON.stringify({ client_name: 'Kept client', redirect_uris: [RP_CALLBACK], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
};

/** The backchannel authentication request of call-center for testuser (CIBA Core 1.0 §7.1). */
const CIBA_REQUEST: LiveOp.LiveRequest = {
  method: 'POST',
  path: '/backchannel_authentication',
  headers: [['content-type', 'application/x-www-form-urlencoded'], ['authorization', `Basic ${btoa('call-center:call-center-secret-value')}`]],
  body: 'scope=openid&login_hint=testuser',
};

/** The authorization request of client-1 without a session (prompt=none), answered in a response mode. */
function silentAuthorization(responseMode: string): LiveOp.LiveRequest {
  const query = new URLSearchParams({ response_type: 'code', client_id: 'client-1', redirect_uri: RP_CALLBACK, scope: 'openid', prompt: 'none', response_mode: responseMode, state: 's', code_challenge: CHALLENGE, code_challenge_method: 'S256' });
  return { method: 'GET', path: `/authorize?${query}`, headers: [] };
}

/** A JWT with a payload and no valid signature (a JARM response is read without verifying it). */
function unsignedJwt(payload: Record<string, unknown>): string {
  const part = (value: unknown): string => base64Url(new TextEncoder().encode(JSON.stringify(value)));
  return `${part({ alg: 'RS256' })}.${part(payload)}.c2lnbmF0dXJl`;
}

/** A storage that cannot read what it kept (a part lost), and keeps what it is given after. */
class UnreadableStorage extends MemoryStorage {
  override async load(): Promise<LiveOp.WorkspaceSnapshot | undefined> {
    throw new Error('The storage lost a part of snapshot.');
  }
}

describe('LiveWorkspace', () => {
  it('should keep the state of the OP from one request to the next', async () => {
    const workspace = await LiveWorkspace.open('continuity', ISSUER);
    const prepared = await prepareRecipe(workspace, 'token-authorization-code', RECIPES['token-authorization-code']!);
    const first = await workspace.send(prepared.request, 'relay');
    const second = await workspace.send(prepared.request, 'relay');
    expect(first.exchange.status).toBe(200);
    expect(second.exchange.status).toBe(400);
    expect(second.exchange.error).toBe('invalid_grant');
  });

  it('should open again from its storage with the codes, the tokens and the signing key it held', async () => {
    const storage = new MemoryStorage();
    const before = await LiveWorkspace.open('reopened', ISSUER, storage);
    const grant = await runGrant(before, await client1Grant(true));
    const accessToken = grant.tokens?.['access_token'];
    const userinfoRequest: LiveOp.LiveRequest = { method: 'GET', path: '/userinfo', headers: [['authorization', `Bearer ${String(accessToken)}`]] };
    const keysBefore = (await before.send(JWKS, 'relay')).exchange.response?.body;
    const reopened = await LiveWorkspace.open('reopened', ISSUER, storage);
    const keysAfter = (await reopened.send(JWKS, 'relay')).exchange.response?.body;
    const userinfo = await reopened.send(userinfoRequest, 'relay');
    const replayed = await reopened.send(codeExchange(grant), 'relay');
    // A code sent twice revokes the tokens issued for it (RFC 6749 §4.1.2).
    const revoked = await reopened.send(userinfoRequest, 'relay');
    expect(grant.failure).toBeUndefined();
    expect(typeof accessToken).toBe('string');
    expect(keysAfter).toBe(keysBefore);
    expect(JSON.parse(keysAfter ?? '{}')).toMatchObject({ keys: [{ kid: keyIdOf(grant.tokens?.['id_token']) }] });
    expect(userinfo.exchange.status).toBe(200);
    expect(JSON.parse(userinfo.exchange.response?.body ?? '{}')).toMatchObject({ sub: 'testuser' });
    expect(replayed.exchange.error).toBe('invalid_grant');
    expect(revoked.exchange.status).toBe(401);
    expect(reopened.summaries().map((summary) => summary.id).slice(0, before.summaries().length)).toEqual(before.summaries().map((summary) => summary.id));
    expect(reopened.summaries().slice(-3).map((summary) => summary.id)).toEqual([userinfo.exchange.id, replayed.exchange.id, revoked.exchange.id]);
    expect(await reopened.exchange(grant.steps[0]!.id)).toMatchObject({ id: grant.steps[0]!.id, method: 'GET' });
  });

  it('should expire a code once its clock is moved past the code\'s lifetime', async () => {
    const workspace = await LiveWorkspace.open('clock', ISSUER);
    const grant = await runGrant(workspace, await client1Grant(false));
    const before = workspace.now();
    await workspace.advanceClock(301);
    const exchanged = await workspace.send(codeExchange(grant), 'relay');
    expect(grant.code).toBeDefined();
    expect(workspace.state().clockOffset).toBe(301);
    expect(workspace.now() - before).toBeGreaterThanOrEqual(301_000);
    expect(exchanged.exchange.at).toBeGreaterThanOrEqual(before + 301_000);
    expect(exchanged.exchange.status).toBe(400);
    expect(exchanged.exchange.error).toBe('invalid_grant');
  });

  it('should refuse to move its clock back or by more than a year', async () => {
    const workspace = await LiveWorkspace.open('clock-bounds', ISSUER);
    await expect(workspace.advanceClock(-1)).rejects.toThrow();
    await expect(workspace.advanceClock(367 * 24 * 3600)).rejects.toThrow();
    expect(workspace.state().clockOffset).toBe(0);
  });

  it('should start over on reset, dropping the records and the exchanges but not reusing exchange ids', async () => {
    const workspace = await LiveWorkspace.open('reset', ISSUER);
    const grant = await runGrant(workspace, await client1Grant(true));
    const counted = workspace.state().exchanges;
    await workspace.reset();
    const after = workspace.state();
    const next = await workspace.send(DISCOVERY, 'relay');
    expect(counted).toBe(grant.steps.length);
    expect(workspace.summaries().map((summary) => summary.id)).toEqual([next.exchange.id]);
    expect(await workspace.exchange(grant.steps[0]!.id)).toBeUndefined();
    expect(after.records.filter((record) => record.addedBy !== undefined || record.changedBy !== undefined)).toEqual([]);
    expect(after.records.some((record) => record.collection === 'codes' || record.collection === 'accessTokens')).toBe(false);
    expect(after.exchanges).toBe(counted);
    expect(next.exchange.id).toBe(`x${counted + 1}`);
  });

  it('should keep the last MAX_EXCHANGES exchanges and drop the older ones', async () => {
    const workspace = await LiveWorkspace.open('trimmed', ISSUER);
    for (let sent = 0; sent < MAX_EXCHANGES + 5; sent += 1) await workspace.send(DISCOVERY, 'relay');
    const kept = workspace.summaries();
    expect(kept).toHaveLength(MAX_EXCHANGES);
    expect(kept[0]?.id).toBe('x6');
    expect(kept.at(-1)?.id).toBe(`x${MAX_EXCHANGES + 5}`);
    expect(await workspace.exchange('x5')).toBeUndefined();
    expect(await workspace.exchange('x6')).toMatchObject({ id: 'x6', status: 200 });
    expect(workspace.summaries(`x${MAX_EXCHANGES + 3}`).map((summary) => summary.id)).toEqual([`x${MAX_EXCHANGES + 4}`, `x${MAX_EXCHANGES + 5}`]);
    expect(workspace.state().exchanges).toBe(MAX_EXCHANGES + 5);
  });

  it('should name the exchanges that added and changed each record', async () => {
    const workspace = await LiveWorkspace.open('provenance', ISSUER);
    const grant = await runGrant(workspace, await client1Grant(true));
    const tokenStep = grant.steps.at(-1)!;
    const ids = new Set(grant.steps.map((step) => step.id));
    const records = workspace.state().records;
    const code = records.find((record) => record.collection === 'codes' && record.key === grant.code);
    const traced = records.filter((record) => record.addedBy !== undefined);
    expect(tokenStep.path).toBe('/token');
    expect(traced.length).toBeGreaterThan(0);
    expect(traced.every((record) => ids.has(record.addedBy!))).toBe(true);
    expect(records.some((record) => record.collection === 'accessTokens' && record.addedBy === tokenStep.id)).toBe(true);
    expect(code?.addedBy).toBeDefined();
    expect(code?.addedBy).not.toBe(tokenStep.id);
    expect(code?.changedBy).toContain(tokenStep.id);
    expect(records.filter((record) => record.collection === 'clients').every((record) => record.addedBy === undefined)).toBe(true);
  });

  it('should record the order of what a request ran against the probe table of the build', async () => {
    const workspace = await LiveWorkspace.open('trace', ISSUER);
    const { exchange } = await workspace.send(DISCOVERY, 'relay');
    const kept = await workspace.exchange(exchange.id);
    const table = probeTable();
    expect(exchange.trace.events.length).toBeGreaterThan(0);
    expect(exchange.trace.probes).toBe(table.hash);
    expect(exchange.trace.events.every((probe) => probe >= 0 && probe < table.probes.length)).toBe(true);
    expect(kept?.trace).toEqual(exchange.trace);
    expect(workspace.state().probes).toBe(table.hash);
  });
});

describe('LiveWorkspace.open on what a storage kept', () => {
  it('should start over with a notice when what it kept cannot be made again, and answer and reset after', async () => {
    const storage = new MemoryStorage();
    const before = await LiveWorkspace.open('unknown-write', ISSUER, storage);
    const sent = await before.send(DISCOVERY, 'relay');
    const kept = (await storage.load())!;
    // A write of a store an older build of the OP had.
    await storage.save({ ...kept, featureWrites: [...kept.featureWrites, { store: 'oldStore' as 'par', method: 'save', at: Date.now(), args: [{ id: 'a' }] }] });
    const reopened = await LiveWorkspace.open('unknown-write', ISSUER, storage);
    const answered = await reopened.send(DISCOVERY, 'relay');
    const noticed = reopened.state().notice;
    await reopened.reset();
    expect(noticed).toMatch(/^保存していた状態を読めなかったので、ワークスペースを作り直しました（.*oldStore.*）。$/);
    expect(answered.exchange.status).toBe(200);
    expect(answered.exchange.id).toBe('x2');
    expect(await reopened.exchange(sent.exchange.id)).toBeUndefined();
    expect(reopened.state().notice).toBeUndefined();
    expect((await LiveWorkspace.open('unknown-write', ISSUER, storage)).state().notice).toBeUndefined();
  });

  it('should start over with a notice when its storage cannot be read at all', async () => {
    const workspace = await LiveWorkspace.open('unreadable', ISSUER, new UnreadableStorage());
    const answered = await workspace.send(DISCOVERY, 'relay');
    expect(workspace.state().notice).toBe('保存していた状態を読めなかったので、ワークスペースを作り直しました（The storage lost a part of snapshot.）。');
    expect(answered.exchange.status).toBe(200);
  });

  it('should start over with a notice when another build of the OP or another configuration kept it', async () => {
    const storage = new MemoryStorage();
    const before = await LiveWorkspace.open('older-build', ISSUER, storage);
    const sent = await before.send(DISCOVERY, 'relay');
    const kept = (await storage.load())!;
    const database = kept.database as { clients: { $map: Array<[string, unknown]> } };
    // An older build: another probe table, and without call-center among its clients.
    await storage.save({ ...kept, build: 'older-build', database: { ...database, clients: { $map: database.clients.$map.filter(([id]) => id !== 'call-center') } } });
    const reopened = await LiveWorkspace.open('older-build', ISSUER, storage);
    const ciba = await reopened.send(CIBA_REQUEST, 'relay');
    await storage.save({ ...(await storage.load())!, version: 1 as 2 });
    const older = await LiveWorkspace.open('older-build', ISSUER, storage);
    expect(reopened.state().notice).toBe('OP のコードか設定が変わったので、ワークスペースを作り直しました。');
    expect(ciba.exchange.status).toBe(200);
    expect(ciba.exchange.id).toBe('x2');
    expect(await reopened.exchange(sent.exchange.id)).toBeUndefined();
    expect(older.state().notice).toBe('OP のコードか設定が変わったので、ワークスペースを作り直しました。');
    expect(older.state().exchanges).toBe(2);
  });

  it('should keep a client\'s JSON whose members are named as the codec\'s tags as it was after it opens again', async () => {
    const storage = new MemoryStorage();
    const workspace = await LiveWorkspace.open('tagged-claims', ISSUER, storage);
    const claims = { userinfo: { email: { $set: ['x'] } } };
    const query = new URLSearchParams({ response_type: 'code', client_id: 'client-1', redirect_uri: RP_CALLBACK, scope: 'openid', code_challenge: CHALLENGE, code_challenge_method: 'S256', claims: JSON.stringify(claims) });
    await workspace.send({ method: 'GET', path: `/authorize?${query}`, headers: [] }, 'relay');
    const reopened = await LiveWorkspace.open('tagged-claims', ISSUER, storage);
    const transactions = (state: LiveOp.LiveState): unknown[] => state.records.filter((record) => record.collection === 'transactions').map((record) => record.value);
    expect(transactions(workspace.state())).toHaveLength(1);
    expect(JSON.stringify(transactions(workspace.state()))).toContain('{"email":{"$set":["x"]}}');
    expect(transactions(reopened.state())).toEqual(transactions(workspace.state()));
    expect(reopened.state().notice).toBeUndefined();
  });
});

describe('LiveWorkspace limits', () => {
  it('should drop the writes of pushed requests an hour old and keep those of registered clients', async () => {
    const storage = new MemoryStorage();
    const workspace = await LiveWorkspace.open('pruned', ISSUER, storage);
    const par = await workspace.send(pushed(), 'relay');
    const registered = await workspace.send(REGISTRATION, 'relay');
    const stores = async (): Promise<string[]> => [...new Set((await storage.load())!.featureWrites.map((write) => write.store))].sort();
    const before = await stores();
    await workspace.advanceClock(59 * 60);
    await workspace.send(DISCOVERY, 'relay');
    const withinTheHour = await stores();
    await workspace.advanceClock(2 * 60);
    await workspace.send(DISCOVERY, 'relay');
    const after = await stores();
    const reopened = await LiveWorkspace.open('pruned', ISSUER, storage);
    expect(par.exchange.status).toBe(201);
    expect(registered.exchange.status).toBe(201);
    expect(before).toEqual(['par', 'registration']);
    expect(withinTheHour).toEqual(['par', 'registration']);
    expect(after).toEqual(['registration']);
    expect(reopened.state().notice).toBeUndefined();
    expect(reopened.state().records.filter((record) => record.collection === 'registeredClients')).toHaveLength(1);
  });

  it('should start over with a notice, keeping the exchange, once what it holds grows past 8 MiB', async () => {
    const storage = new MemoryStorage();
    const workspace = await LiveWorkspace.open('grown', ISSUER, storage);
    let last: LiveOp.Answered | undefined;
    for (let sent = 0; sent < 200 && workspace.state().notice === undefined; sent += 1) last = await workspace.send(pushed(60 * 1024), 'relay');
    const kept = (await storage.load())!;
    expect(workspace.state().notice).toBe('ワークスペースが保つ状態が 8 MiB を超えたので、ワークスペースを作り直しました（地図の OP の遊び場としての制限です）。');
    expect(last?.exchange.status).toBe(201);
    expect(workspace.summaries().map((summary) => summary.id)).toEqual([last?.exchange.id]);
    expect(await workspace.exchange(last!.exchange.id)).toMatchObject({ status: 201 });
    expect(await workspace.exchange('x1')).toBeUndefined();
    expect(JSON.stringify(kept).length).toBeLessThan(1024 * 1024);
    expect(kept.featureWrites).toEqual([]);
  });

  it('should give every exchange an id of its own when a reset races its requests', async () => {
    const workspace = await LiveWorkspace.open('racing', ISSUER);
    const first = await Promise.all([1, 2, 3].map(() => workspace.send(DISCOVERY, 'relay')));
    const racing = await Promise.all([
      ...Array.from({ length: 15 }, () => workspace.send(DISCOVERY, 'relay')),
      workspace.reset().then(() => undefined),
      ...Array.from({ length: 15 }, () => workspace.send(DISCOVERY, 'relay')),
    ]);
    const after = await workspace.send(DISCOVERY, 'relay');
    const ids = [...first, ...racing, after].flatMap((answered) => (answered === undefined ? [] : [answered.exchange.id]));
    expect(ids).toHaveLength(34);
    expect(new Set(ids).size).toBe(34);
    expect(workspace.summaries().map((summary) => summary.id)).toEqual(ids.slice(18));
    expect(after.exchange.id).toBe('x34');
  });
});

describe('the exchanges of a workspace', () => {
  /** A request over HTTP as it reaches the OP behind Cloudflare: the client's headers and the host's. */
  function overHttp(): Request {
    return new Request(new URL('/.well-known/openid-configuration', ISSUER), {
      headers: {
        authorization: 'Basic Y2xpZW50LTE6c2VjcmV0',
        cookie: '__Host-oidc_txn=t1; map_workspace=w1',
        accept: 'application/json',
        'cf-connecting-ip': '203.0.113.7',
        'cf-ray': '8a1b2c3d4e5f-NRT',
        'cf-ipcountry': 'JP',
        'x-forwarded-for': '203.0.113.7',
        'x-forwarded-proto': 'https',
        'x-real-ip': '203.0.113.7',
      },
    });
  }

  it('should keep the headers the client sent over HTTP, not those its host added', async () => {
    const workspace = await LiveWorkspace.open('host-headers', ISSUER);
    const { exchange } = await workspace.answer(overHttp(), 'http');
    const relayed = await workspace.send({ method: 'GET', path: '/.well-known/jwks.json', headers: [['x-forwarded-for', '198.51.100.1']] }, 'relay');
    expect(exchange.request.headers).toEqual([['accept', 'application/json'], ['authorization', 'Basic Y2xpZW50LTE6c2VjcmV0'], ['cookie', '__Host-oidc_txn=t1; map_workspace=w1']]);
    expect(relayed.exchange.request.headers).toEqual([['x-forwarded-for', '198.51.100.1']]);
  });

  it('should hide the values of the credentials of a request in the public workspace, which anyone can read', async () => {
    const workspace = await LiveWorkspace.open(PUBLIC_WORKSPACE, ISSUER);
    const { exchange } = await workspace.answer(overHttp(), 'http');
    const kept = await workspace.exchange(exchange.id);
    expect(kept?.request.headers).toEqual([
      ['accept', 'application/json'],
      ['authorization', 'Basic （公開ワークスペースでは隠す）'],
      ['cookie', '__Host-oidc_txn=（公開ワークスペースでは隠す）; map_workspace=（公開ワークスペースでは隠す）'],
    ]);
  });

  it('should name the error a form_post page or a JARM response delivers', async () => {
    const workspace = await LiveWorkspace.open('response-modes', ISSUER);
    const formPost = await workspace.send(silentAuthorization('form_post'), 'relay');
    const jarm = await workspace.send(silentAuthorization('query.jwt'), 'relay');
    const fragment = await workspace.send(silentAuthorization('fragment'), 'relay');
    expect(formPost.exchange.status).toBe(200);
    expect(formPost.exchange.error).toBe('login_required');
    expect(jarm.exchange.status).toBe(302);
    expect(jarm.exchange.error).toBe('login_required');
    expect(fragment.exchange.error).toBe('login_required');
  });
});

describe('oauthErrorOf', () => {
  const html = new Headers({ 'content-type': 'text/html; charset=UTF-8' });

  it('should read the error of a form_post page, whatever the order of the input\'s attributes', () => {
    const page = '<form method="post" action="https://rp.example.com/cb"><input value="access_denied" name="error" type="hidden"/><input type="hidden" name="error_description" value="&quot;no&quot;"/></form>';
    expect(oauthErrorOf(200, html, page)).toBe('access_denied');
    expect(oauthErrorOf(200, html, '<form method="post"><input type="hidden" name="code" value="abc"/><input type="hidden" name="state" value="s"/></form>')).toBeUndefined();
  });

  it('should read the error of a JARM response in a redirect\'s query or fragment, or in a form, without verifying it', () => {
    const jwt = unsignedJwt({ iss: ISSUER, aud: 'client-1', error: 'invalid_scope' });
    expect(oauthErrorOf(302, new Headers({ location: `${RP_CALLBACK}?response=${jwt}` }), '')).toBe('invalid_scope');
    expect(oauthErrorOf(302, new Headers({ location: `${RP_CALLBACK}#response=${jwt}` }), '')).toBe('invalid_scope');
    expect(oauthErrorOf(200, html, `<form method="post"><input type="hidden" name="response" value="${jwt}"/></form>`)).toBe('invalid_scope');
    expect(oauthErrorOf(302, new Headers({ location: `${RP_CALLBACK}?response=${unsignedJwt({ code: 'abc' })}` }), '')).toBeUndefined();
    expect(oauthErrorOf(302, new Headers({ location: `${RP_CALLBACK}?response=not-a-jwt` }), '')).toBeUndefined();
  });
});
