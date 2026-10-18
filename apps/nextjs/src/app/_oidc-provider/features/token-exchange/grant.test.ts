import type { TokenClientInfo } from '@maronn-openid-connect/core';
import {
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_TYPE_ACCESS_TOKEN,
} from '@maronn-openid-connect/experimental/token-exchange';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessTokenInfo } from '../../../../test-support/fixtures';
import { decodeJwt } from '../../../../test-support/jwt';
import { providerSigningKeys, rs256Key } from '../../../../test-support/keys';
import { jsonResponseOf } from '../../../../test-support/responses';
import { stores } from '../../provider';
import { dispatchTokenExchange } from './grant';

// provider.ts keeps its stores in the key-value store of db/ (in memory for
// the tests, vitest.config.ts) for the whole file, so every test uses tokens
// of its own.

/** 2026-01-01T00:00:00Z in Unix seconds: every test runs on this clock. */
const NOW = 1767225600;
const ISSUER = 'https://op.example.com';

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
  vi.useRealTimers();
});

function exchangeRequest(subjectToken: string, fields: Record<string, string> = {}): Record<string, string> {
  return {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    subject_token: subjectToken,
    subject_token_type: TOKEN_TYPE_ACCESS_TOKEN,
    ...fields,
  };
}

describe('dispatchTokenExchange', () => {
  it('should return undefined for another grant_type', async () => {
    const keys = providerSigningKeys(await rs256Key());

    const response = await dispatchTokenExchange({ grant_type: 'authorization_code', code: 'code-1' }, client, keys);

    expect(response).toBeUndefined();
  });

  // RFC 8693 §2.2.1 / §1.1: the exchanged token acts as the same subject, bound to the requesting client.
  it('should answer a token exchange with a new access token of the same subject and grant', async () => {
    const signingKey = await rs256Key();
    await stores.accessTokenStore.set(
      'subject-at-exchanged',
      accessTokenInfo({ sub: 'alice', clientId: 'rp-1', scope: ['openid', 'profile'], grantId: 'grant-exchanged' }),
    );

    const response = await dispatchTokenExchange(exchangeRequest('subject-at-exchanged'), client, providerSigningKeys(signingKey));
    const parts = await jsonResponseOf(response);
    const { access_token: accessToken, ...body } = parts?.body as Record<string, unknown>;

    expect({ ...parts, body }).toEqual({
      status: 200,
      contentType: 'application/json',
      cacheControl: 'no-store',
      pragma: 'no-cache',
      body: {
        issued_token_type: TOKEN_TYPE_ACCESS_TOKEN,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile',
      },
    });
    expect(await stores.accessTokenStore.get(accessToken as string)).toMatchObject({
      sub: 'alice',
      clientId: 'service-1',
      scope: ['openid', 'profile'],
      expiresAt: NOW + 3600,
      grantId: 'grant-exchanged',
      issuer: ISSUER,
    });
    expect(decodeJwt(accessToken as string).payload).toMatchObject({ iss: ISSUER, sub: 'alice', client_id: 'service-1' });
  });

  // RFC 6749 §5.2: the errors of the exchange in the JSON error shape, never cached.
  describe('Errors', () => {
    // RFC 7591 §2: grant_types defaults to ["authorization_code"], so the exchange needs registering.
    it('should answer a client that did not register the grant with unauthorized_client', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const response = await dispatchTokenExchange(
        exchangeRequest('subject-at-any'),
        { ...client, grantTypes: ['authorization_code'] },
        keys,
      );

      expect(await jsonResponseOf(response)).toEqual({
        status: 400,
        contentType: 'application/json',
        cacheControl: 'no-store',
        pragma: 'no-cache',
        body: {
          error: 'unauthorized_client',
          error_description: 'The client is not authorized to use the token-exchange grant type',
        },
      });
    });

    // RFC 8693 §2.2.2: an unknown subject_token is invalid_request, without telling why.
    it('should answer a subject_token this OP does not know with invalid_request', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const response = await dispatchTokenExchange(exchangeRequest('subject-at-unknown'), client, keys);

      expect(await jsonResponseOf(response)).toEqual({
        status: 400,
        contentType: 'application/json',
        cacheControl: 'no-store',
        pragma: 'no-cache',
        body: { error: 'invalid_request', error_description: 'The provided subject_token is not valid' },
      });
    });

    // RFC 8693 §2.2.2: invalid_target for an audience outside
    // tokenExchangeConfig.allowedTargets, which is empty by default.
    it('should answer an audience outside allowedTargets with invalid_target', async () => {
      await stores.accessTokenStore.set('subject-at-target', accessTokenInfo({ grantId: 'grant-target' }));

      const response = await dispatchTokenExchange(
        exchangeRequest('subject-at-target', { audience: 'https://api.example.com' }),
        client,
        providerSigningKeys(await rs256Key()),
      );

      expect(await jsonResponseOf(response)).toMatchObject({
        status: 400,
        body: { error: 'invalid_target', error_description: 'The requested target is not allowed for token exchange' },
      });
    });
  });
});
