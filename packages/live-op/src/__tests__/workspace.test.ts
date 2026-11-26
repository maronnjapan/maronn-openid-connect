import { describe, expect, it } from 'vitest';
import type * as LiveOp from '../index.js';

// The built bundle (the package script builds it first), the OP a host runs; a URL, so the type checker leaves it to the types of the sources.
const { LiveWorkspace, MAX_EXCHANGES, MemoryStorage, prepareRecipe, probeTable, RECIPES, RP_CALLBACK, runGrant } = await import(new URL('../../dist/live-op.js', import.meta.url).href) as typeof LiveOp;

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
