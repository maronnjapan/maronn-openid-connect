import { beforeAll, describe, expect, it } from 'vitest';
import { TEST_ISSUER } from '../../../test-support/context';
import { accessTokenInfo, refreshTokenInfo } from '../../../test-support/fixtures';
import { decodeJwt } from '../../../test-support/jwt';
import { createDatabase, registerClient } from '../../_oidc-provider/db';
import { stores } from '../../_oidc-provider/provider';
import { accessTokenRecordOf, refreshTokenRecordOf } from '../../_oidc-provider/token-binding';
import { POST } from './route';

// provider.ts keeps its clients and stores in the key-value store of db/ (in
// memory for the tests, vitest.config.ts) for the whole file, so every test
// stores a token of its own.

const CLIENT_ID = 'introspect-route-resource-server';
const CLIENT_SECRET = 'introspect-route-secret';
const BINDING = { cnf: { jkt: 'jkt-1' }, tokenType: 'DPoP' };

beforeAll(async () => {
  await registerClient(createDatabase(), {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [],
    tokenEndpointAuthMethods: ['client_secret_basic'],
  });
});

/** A POST of the fields to /introspect as a form, authenticated as the resource server with client_secret_basic, with the headers. */
function introspect(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(`${TEST_ISSUER}/introspect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

describe('POST /introspect', () => {
  // RFC 7662 §2.2: a token that is not bound keeps token_type Bearer and has no cnf.
  it('should describe an active access token that is not bound to a key as a Bearer token', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    await stores.accessTokenStore.set('introspect-route-at-bearer', accessTokenInfo({ clientId: 'client-1', expiresAt: exp }));

    const response = await POST(introspect({ token: 'introspect-route-at-bearer' }));

    expect({ status: response.status, cacheControl: response.headers.get('Cache-Control'), body: await response.json() }).toEqual({
      status: 200,
      cacheControl: 'no-store',
      body: { active: true, scope: 'openid', client_id: 'client-1', token_type: 'Bearer', sub: 'user-1', exp },
    });
  });

  // RFC 9449 §6.2: a token bound to a key is described with its cnf and token_type DPoP.
  it('should describe the key and the token_type of an access token bound to a key', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    await stores.accessTokenStore.set('introspect-route-at-bound', {
      ...accessTokenInfo({ clientId: 'client-1', expiresAt: exp }),
      ...accessTokenRecordOf(BINDING),
    });

    const response = await POST(introspect({ token: 'introspect-route-at-bound' }));

    expect(await response.json()).toEqual({
      active: true,
      scope: 'openid',
      client_id: 'client-1',
      token_type: 'DPoP',
      sub: 'user-1',
      exp,
      cnf: { jkt: 'jkt-1' },
    });
  });

  // RFC 9449 §6.2 / RFC 9701 §5 (feature: jwt-introspection-response): the signed response carries the cnf too.
  it('should sign the key and the token_type of an access token bound to a key into the JWT response', async () => {
    await stores.accessTokenStore.set('introspect-route-at-bound-jwt', {
      ...accessTokenInfo({ clientId: 'client-1', audience: [CLIENT_ID] }),
      ...accessTokenRecordOf(BINDING),
    });

    const response = await POST(
      introspect({ token: 'introspect-route-at-bound-jwt' }, { Accept: 'application/token-introspection+jwt' }),
    );

    expect({ contentType: response.headers.get('Content-Type'), payload: decodeJwt(await response.text()).payload }).toMatchObject({
      contentType: 'application/token-introspection+jwt',
      payload: { token_introspection: { active: true, client_id: 'client-1', token_type: 'DPoP', cnf: { jkt: 'jkt-1' } } },
    });
  });

  // RFC 9449 §6.2 is about access tokens: a bound refresh token keeps the response of RFC 7662.
  it('should describe a refresh token bound to a key without its key', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    await stores.refreshTokenStore.set('introspect-route-rt-bound', {
      ...refreshTokenInfo({ clientId: 'client-1', expiresAt: exp }),
      ...refreshTokenRecordOf({ ...BINDING, refreshTokenCnf: { jkt: 'jkt-1' } }),
    });

    const response = await POST(introspect({ token: 'introspect-route-rt-bound', token_type_hint: 'refresh_token' }));

    expect(await response.json()).toEqual({
      active: true,
      scope: 'openid',
      client_id: 'client-1',
      token_type: 'refresh_token',
      sub: 'user-1',
      exp,
    });
  });

  // RFC 7662 §2.2: an unknown token is not told apart from an inactive one.
  it('should answer { active: false } for a token the provider never issued', async () => {
    const response = await POST(introspect({ token: 'introspect-route-unknown' }));

    expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { active: false } });
  });
});
