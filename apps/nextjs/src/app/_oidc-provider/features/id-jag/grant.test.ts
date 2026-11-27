import { signJwt, type Jwk, type SigningKey, type TokenClientInfo } from '@maronn-openid-connect/core';
import {
  ID_JAG_TOKEN_TYPE,
  JWT_BEARER_GRANT_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_TYPE_ACCESS_TOKEN,
  TOKEN_TYPE_ID_TOKEN,
} from '@maronn-openid-connect/experimental/id-jag';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeJwt } from '../../../../test-support/jwt';
import { es256Key, providerSigningKeys, rs256Key } from '../../../../test-support/keys';
import { jsonResponseOf } from '../../../../test-support/responses';
import { features } from '../../features';
import { stores } from '../../provider';
import type { TokenBinding } from '../../token-binding';
import { idJagConfig } from './config';
import { dispatchIdJagIssuance, dispatchIdJagRedemption } from './grant';

/** The issuer of this OP (OIDC_ISSUER of vitest.config.ts), the audience of the ID-JAGs it redeems. */
const ISSUER = 'https://op.example.com';
const IDP = 'https://idp.partner.example';
const defaultTrustedIdentityProviders = idJagConfig.trustedIdentityProviders;

/** The JWK Thumbprint (RFC 7638) of a DPoP key the access token is bound to. */
const JKT = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';

/** The binding the dpop extension hands the grant for a DPoP proof of that key (RFC 9449 §5). */
const BINDING: TokenBinding = { cnf: { jkt: JKT }, tokenType: 'DPoP', refreshTokenCnf: { jkt: JKT } };

const client: TokenClientInfo = {
  clientId: 'rp-1',
  grantTypes: ['authorization_code', TOKEN_EXCHANGE_GRANT_TYPE, JWT_BEARER_GRANT_TYPE],
  tokenEndpointAuthMethods: ['client_secret_basic'],
};

/** Trust the partner identity provider with its keys inline (never a jwksUri: no network). */
async function trustPartnerIdp(): Promise<SigningKey> {
  const key = await rs256Key('partner-idp-key');
  idJagConfig.trustedIdentityProviders = [{ issuer: IDP, jwks: { keys: [key.publicJwk as Jwk] } }];
  return key;
}

/** An ID-JAG the partner identity provider issued for this OP and rp-1, valid for 300 seconds (ID-JAG draft §3.1). */
function idJag(key: SigningKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    { alg: 'RS256', kid: key.keyId, typ: 'oauth-id-jag+jwt' },
    {
      iss: IDP,
      sub: 'alice@partner',
      aud: ISSUER,
      client_id: 'rp-1',
      jti: 'jag-1',
      iat: now,
      exp: now + 300,
      scope: 'calendar.read',
    },
    key.privateKey,
  );
}

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
  afterEach(() => {
    idJagConfig.trustedIdentityProviders = defaultTrustedIdentityProviders;
  });

  it('should return undefined for another grant_type', async () => {
    const keys = providerSigningKeys(await rs256Key());

    expect(await dispatchIdJagRedemption(issuanceRequest(), client, keys)).toBeUndefined();
  });

  // ID-JAG draft §4.4 / RFC 9449 §5 / §6.1: a binding of the dpop extension puts its cnf into the access token
  // this OP issues for the ID-JAG and into its record, and answers its token_type.
  it('should bind the access token to the key of the binding', async () => {
    const assertion = await idJag(await trustPartnerIdp());

    const response = await dispatchIdJagRedemption(
      { grant_type: JWT_BEARER_GRANT_TYPE, assertion },
      client,
      providerSigningKeys(await rs256Key()),
      BINDING,
    );
    const parts = await jsonResponseOf(response);
    const { access_token: accessToken, ...body } = parts?.body as Record<string, unknown>;

    expect({ ...parts, body }).toEqual({
      status: 200,
      contentType: 'application/json',
      cacheControl: 'no-store',
      pragma: 'no-cache',
      body: { token_type: 'DPoP', expires_in: 3600, scope: 'calendar.read' },
    });
    expect(await stores.accessTokenStore.get(accessToken as string)).toMatchObject({
      sub: 'alice@partner',
      clientId: 'rp-1',
      scope: ['calendar.read'],
      cnf: { jkt: JKT },
      tokenType: 'DPoP',
    });
    expect(decodeJwt(accessToken as string).payload).toMatchObject({
      iss: ISSUER,
      sub: 'alice@partner',
      client_id: 'rp-1',
      cnf: { jkt: JKT },
    });
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
