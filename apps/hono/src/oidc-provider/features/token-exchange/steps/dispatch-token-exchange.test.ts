import type { AccessTokenInfo, TokenClientInfo } from '@maronn-openid-connect/core';
import { TOKEN_EXCHANGE_GRANT_TYPE, TOKEN_TYPE_ACCESS_TOKEN } from '@maronn-openid-connect/experimental/token-exchange';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerContext, TEST_ISSUER } from '../../../../test-support/context.js';
import { decodeJwt } from '../../../../test-support/extensions.js';
import { TokenEndpointError, type TokenRequestBody } from '../../../endpoints/token/response.js';
import { tokenExchangeConfig } from '../config.js';
import { exchangeToken } from './dispatch-token-exchange.js';

/** 2026-01-01T00:00:00Z: every test runs on this clock. */
const NOW = Date.UTC(2026, 0, 1) / 1000;
const USERINFO = `${TEST_ISSUER}/userinfo`;
const defaults = { ...tokenExchangeConfig };

/** The client that asks for the exchange: a confidential client registered for the grant. */
const client: TokenClientInfo = {
  clientId: 'service-1',
  grantTypes: [TOKEN_EXCHANGE_GRANT_TYPE],
  tokenEndpointAuthMethods: ['client_secret_basic'],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  Object.assign(tokenExchangeConfig, defaults);
  vi.useRealTimers();
});

/** An access token this OP issued to rp-1, valid for two hours. */
function subjectToken(overrides: Partial<AccessTokenInfo> = {}): AccessTokenInfo {
  return {
    sub: 'alice',
    scope: ['openid', 'profile', 'email'],
    clientId: 'rp-1',
    expiresAt: NOW + 7200,
    grantId: 'grant-1',
    audience: [USERINFO],
    ...overrides,
  };
}

function exchangeRequest(fields: Record<string, string> = {}): TokenRequestBody {
  return {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    subject_token: 'subject-at',
    subject_token_type: TOKEN_TYPE_ACCESS_TOKEN,
    ...fields,
  } as TokenRequestBody;
}

/** The TokenEndpointError the step fails with. */
async function failureOf(promise: Promise<unknown>): Promise<TokenEndpointError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(TokenEndpointError);
  return error as TokenEndpointError;
}

describe('exchangeToken', () => {
  it('should leave a request of another grant to the next step', async () => {
    const { c } = await providerContext();

    expect(await exchangeToken(c, { grant_type: 'authorization_code' } as TokenRequestBody, client)).toBeUndefined();
  });

  // RFC 8693 §2.2.1 / §1.1: the exchanged token acts as the same subject, bound to the requesting client.
  it('should exchange an access token for a new one of the same subject and grant, bound to the requesting client', async () => {
    const { c, stores } = await providerContext();
    await stores.accessTokenStore.set('subject-at', subjectToken());

    const response = await exchangeToken(c, exchangeRequest(), client);

    const { access_token: accessToken, ...body } = (await response!.json()) as Record<string, unknown>;
    const record = await stores.accessTokenStore.get(accessToken as string);
    expect(response!.status).toBe(200);
    expect(response!.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toEqual({
      issued_token_type: TOKEN_TYPE_ACCESS_TOKEN,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid profile email',
    });
    expect(record).toEqual({
      sub: 'alice',
      clientId: 'service-1',
      scope: ['openid', 'profile', 'email'],
      expiresAt: NOW + 3600,
      grantId: 'grant-1',
      iat: NOW,
      nbf: NOW,
      audience: [USERINFO],
      issuer: TEST_ISSUER,
      jti: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    });
    expect(decodeJwt(accessToken as string).payload).toMatchObject({
      sub: 'alice',
      client_id: 'service-1',
      jti: record!.jti,
    });
  });

  // RFC 8693 §2.1: a narrower scope and a lifetime no longer than the subject token's.
  it('should narrow the scope to the request and cap the lifetime at what the subject token has left', async () => {
    const { c, stores } = await providerContext();
    await stores.accessTokenStore.set('subject-at', subjectToken({ expiresAt: NOW + 120 }));

    const response = await exchangeToken(c, exchangeRequest({ scope: 'openid' }), client);

    expect(await response!.json()).toMatchObject({ expires_in: 120, scope: 'openid' });
  });

  it('should reject an audience while allowedTargets is empty with invalid_target', async () => {
    const { c, stores } = await providerContext();
    await stores.accessTokenStore.set('subject-at', subjectToken());

    const error = await failureOf(exchangeToken(c, exchangeRequest({ audience: 'https://api.example.com' }), client));

    expect(error.response).toEqual({
      status: 400,
      body: { error: 'invalid_target', error_description: 'The requested target is not allowed for token exchange' },
    });
  });

  it('should issue the token for an audience listed in allowedTargets, the UserInfo endpoint kept first', async () => {
    tokenExchangeConfig.allowedTargets = ['https://api.example.com'];
    const { c, stores } = await providerContext();
    await stores.accessTokenStore.set('subject-at', subjectToken());

    const response = await exchangeToken(c, exchangeRequest({ audience: 'https://api.example.com' }), client);

    const { access_token: accessToken } = (await response!.json()) as { access_token: string };
    expect((await stores.accessTokenStore.get(accessToken))!.audience).toEqual([USERINFO, 'https://api.example.com']);
  });

  // RFC 8693 §4.1: a delegation records the actor in the act claim.
  it('should record the subject of the actor_token as the act claim of a delegation', async () => {
    const { c, stores } = await providerContext();
    await stores.accessTokenStore.set('subject-at', subjectToken());
    await stores.accessTokenStore.set('actor-at', subjectToken({ sub: 'agent-1', clientId: 'service-1' }));

    const response = await exchangeToken(
      c,
      exchangeRequest({ actor_token: 'actor-at', actor_token_type: TOKEN_TYPE_ACCESS_TOKEN }),
      client,
    );

    const { access_token: accessToken } = (await response!.json()) as { access_token: string };
    expect(await stores.accessTokenStore.get(accessToken)).toMatchObject({ sub: 'alice', act: { sub: 'agent-1' } });
    expect(decodeJwt(accessToken).payload).toMatchObject({ sub: 'alice', act: { sub: 'agent-1' } });
  });

  // RFC 8693 §2.2.2: an unknown or expired subject_token is invalid_request, without telling which.
  it('should reject a subject_token this OP does not know with invalid_request', async () => {
    const { c } = await providerContext();

    const error = await failureOf(exchangeToken(c, exchangeRequest(), client));

    expect(error.response).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'The provided subject_token is not valid' },
    });
  });

  it('should reject a public client with unauthorized_client', async () => {
    const { c, stores } = await providerContext();
    await stores.accessTokenStore.set('subject-at', subjectToken());

    const error = await failureOf(exchangeToken(c, exchangeRequest(), { ...client, tokenEndpointAuthMethods: ['none'] }));

    expect(error.response).toEqual({
      status: 400,
      body: {
        error: 'unauthorized_client',
        error_description: 'Public clients are not allowed to use the token-exchange grant type',
      },
    });
  });
});
