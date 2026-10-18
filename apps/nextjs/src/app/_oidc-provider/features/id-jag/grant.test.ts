import type { TokenClientInfo } from '@maronn-openid-connect/core';
import {
  ID_JAG_TOKEN_TYPE,
  JWT_BEARER_GRANT_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_TYPE_ACCESS_TOKEN,
  TOKEN_TYPE_ID_TOKEN,
} from '@maronn-openid-connect/experimental/id-jag';
import { describe, expect, it } from 'vitest';
import { es256Key, providerSigningKeys, rs256Key } from '../../../../test-support/keys';
import { jsonResponseOf } from '../../../../test-support/responses';
import { features } from '../../features';
import { dispatchIdJagIssuance, dispatchIdJagRedemption } from './grant';

const client: TokenClientInfo = {
  clientId: 'rp-1',
  grantTypes: ['authorization_code', TOKEN_EXCHANGE_GRANT_TYPE, JWT_BEARER_GRANT_TYPE],
  tokenEndpointAuthMethods: ['client_secret_basic'],
};

function issuanceRequest(fields: Record<string, string> = {}): Record<string, string> {
  return {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    requested_token_type: ID_JAG_TOKEN_TYPE,
    subject_token: 'not-an-id-token',
    subject_token_type: TOKEN_TYPE_ID_TOKEN,
    audience: 'https://as.partner.example',
    ...fields,
  };
}

describe('dispatchIdJagIssuance', () => {
  it('should return undefined for another grant_type', async () => {
    const keys = providerSigningKeys(await rs256Key());

    expect(await dispatchIdJagIssuance({ grant_type: 'authorization_code', code: 'code-1' }, client, keys)).toBeUndefined();
  });

  // ID-JAG draft §4.3: a token exchange that asks for another token type is
  // the token-exchange feature's, which this provider has (features.ts).
  it('should leave a plain token exchange to the token-exchange feature, which is in the feature list', async () => {
    const keys = providerSigningKeys(await rs256Key());

    const response = await dispatchIdJagIssuance(
      issuanceRequest({ requested_token_type: TOKEN_TYPE_ACCESS_TOKEN }),
      client,
      keys,
    );

    expect(features.some((feature) => feature.id === 'token-exchange')).toBe(true);
    expect(response).toBeUndefined();
  });

  // RFC 6749 §5.2: the errors of the issuance in the JSON error shape, never cached.
  describe('Errors', () => {
    it('should answer a client that did not register the token-exchange grant with unauthorized_client', async () => {
      const response = await dispatchIdJagIssuance(
        issuanceRequest(),
        { ...client, grantTypes: ['authorization_code'] },
        providerSigningKeys(await rs256Key()),
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

    // ID-JAG draft §4.3.3: the subject_token must be an ID Token this OP issued
    // to the client; why it is not is not told.
    it('should answer a subject_token that is not an ID Token of this OP with invalid_request', async () => {
      const response = await dispatchIdJagIssuance(issuanceRequest(), client, providerSigningKeys(await rs256Key()));

      expect(await jsonResponseOf(response)).toEqual({
        status: 400,
        contentType: 'application/json',
        cacheControl: 'no-store',
        pragma: 'no-cache',
        body: { error: 'invalid_request', error_description: 'The provided subject_token is not valid' },
      });
    });

    // The ID-JAG is signed with RS256 so the peer AS can verify it (JARM's key-selection contract).
    it('should answer server_error with status 500 when no RS256 signing key is registered', async () => {
      const response = await dispatchIdJagIssuance(issuanceRequest(), client, providerSigningKeys(await es256Key()));

      expect(await jsonResponseOf(response)).toEqual({
        status: 500,
        contentType: 'application/json',
        cacheControl: 'no-store',
        pragma: 'no-cache',
        body: { error: 'server_error', error_description: 'No RS256 signing key registered for ID-JAG issuance' },
      });
    });
  });
});

describe('dispatchIdJagRedemption', () => {
  it('should return undefined for another grant_type', async () => {
    const keys = providerSigningKeys(await rs256Key());

    expect(await dispatchIdJagRedemption(issuanceRequest(), client, keys)).toBeUndefined();
  });

  // RFC 7523 §2.1 / RFC 6749 §5.2: the errors of the redemption in the JSON error shape, never cached.
  describe('Errors', () => {
    it('should answer a client that did not register the jwt-bearer grant with unauthorized_client', async () => {
      const response = await dispatchIdJagRedemption(
        { grant_type: JWT_BEARER_GRANT_TYPE, assertion: 'not-a-jwt' },
        { ...client, grantTypes: ['authorization_code'] },
        providerSigningKeys(await rs256Key()),
      );

      expect(await jsonResponseOf(response)).toEqual({
        status: 400,
        contentType: 'application/json',
        cacheControl: 'no-store',
        pragma: 'no-cache',
        body: {
          error: 'unauthorized_client',
          error_description: 'The client is not authorized to use the jwt-bearer grant type',
        },
      });
    });

    // RFC 7521 §4.1: an assertion that cannot be used is invalid_grant.
    it('should answer an assertion that is not a compact JWS with invalid_grant', async () => {
      const response = await dispatchIdJagRedemption(
        { grant_type: JWT_BEARER_GRANT_TYPE, assertion: 'not-a-jwt' },
        client,
        providerSigningKeys(await rs256Key()),
      );

      expect(await jsonResponseOf(response)).toEqual({
        status: 400,
        contentType: 'application/json',
        cacheControl: 'no-store',
        pragma: 'no-cache',
        body: {
          error: 'invalid_grant',
          error_description: 'The provided assertion is not a valid JWS compact serialization',
        },
      });
    });
  });
});
