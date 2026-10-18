import type { Jwk, SigningKey, TokenClientInfo } from '@maronn-openid-connect/core';
import {
  ASSERTION_UNTRUSTED_DESCRIPTION,
  JWT_BEARER_GRANT_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
} from '@maronn-openid-connect/experimental/id-jag';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerContext, TEST_ISSUER } from '../../../../test-support/context.js';
import { decodeJwt, signTestJwt } from '../../../../test-support/extensions.js';
import { rs256Key } from '../../../../test-support/keys.js';
import { TokenEndpointError, type TokenRequestBody } from '../../../endpoints/token/response.js';
import { idJagConfig } from '../config.js';
import { redeemIdJag } from './dispatch-id-jag-redemption.js';

/** 2026-01-01T00:00:00Z: every test runs on this clock. */
const NOW = Date.UTC(2026, 0, 1) / 1000;
const IDP = 'https://idp.partner.example';
const USERINFO = `${TEST_ISSUER}/userinfo`;
const defaults = { ...idJagConfig };

const client: TokenClientInfo = {
  clientId: 'rp-1',
  grantTypes: ['authorization_code', JWT_BEARER_GRANT_TYPE],
  tokenEndpointAuthMethods: ['client_secret_basic'],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  Object.assign(idJagConfig, defaults);
  vi.useRealTimers();
});

/** Trust the partner identity provider with its keys inline (never a jwksUri: no network). */
async function trustPartnerIdp(): Promise<SigningKey> {
  const key = await rs256Key('partner-idp-key');
  idJagConfig.trustedIdentityProviders = [{ issuer: IDP, jwks: { keys: [key.publicJwk as Jwk] } }];
  return key;
}

/** An ID-JAG the partner identity provider issued for this OP and rp-1 (ID-JAG draft §3.1). */
function idJag(key: SigningKey, claims: Record<string, unknown> = {}): Promise<string> {
  return signTestJwt(
    key,
    {
      iss: IDP,
      sub: 'alice@partner',
      aud: TEST_ISSUER,
      client_id: 'rp-1',
      jti: 'jag-1',
      iat: NOW,
      exp: NOW + 300,
      scope: 'calendar.read offline_access',
      ...claims,
    },
    { typ: 'oauth-id-jag+jwt' },
  );
}

function redemptionRequest(assertion: string): TokenRequestBody {
  return { grant_type: JWT_BEARER_GRANT_TYPE, assertion } as TokenRequestBody;
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

describe('redeemIdJag', () => {
  it('should leave a request of another grant to the next step', async () => {
    const { c } = await providerContext();

    const authorizationCode = await redeemIdJag(c, { grant_type: 'authorization_code' } as TokenRequestBody, client);
    const tokenExchange = await redeemIdJag(c, { grant_type: TOKEN_EXCHANGE_GRANT_TYPE } as TokenRequestBody, client);

    expect([authorizationCode, tokenExchange]).toEqual([undefined, undefined]);
  });

  // ID-JAG draft §4.4 / RFC 7523 §2.1: this OP issues its own access token; no ID Token, no refresh token.
  it('should issue a bearer access token for an ID-JAG of a trusted identity provider and store its record', async () => {
    const { c, stores } = await providerContext();
    const assertion = await idJag(await trustPartnerIdp());

    const response = await redeemIdJag(c, redemptionRequest(assertion), client);

    const { access_token: accessToken, ...body } = (await response!.json()) as Record<string, unknown>;
    const record = await stores.accessTokenStore.get(accessToken as string);
    expect(response!.status).toBe(200);
    expect(response!.headers.get('Cache-Control')).toBe('no-store');
    // ID-JAG draft §4.4.3: offline_access is dropped, since no refresh token is issued.
    expect(body).toEqual({ token_type: 'Bearer', expires_in: 3600, scope: 'calendar.read' });
    expect(record).toEqual({
      sub: 'alice@partner',
      clientId: 'rp-1',
      scope: ['calendar.read'],
      expiresAt: NOW + 3600,
      grantId: record!.jti,
      iat: NOW,
      nbf: NOW,
      audience: [USERINFO],
      issuer: TEST_ISSUER,
      jti: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    });
    expect(decodeJwt(accessToken as string).payload).toMatchObject({
      iss: TEST_ISSUER,
      sub: 'alice@partner',
      client_id: 'rp-1',
      aud: [USERINFO],
      scope: 'calendar.read',
      jti: record!.jti,
    });
  });

  it('should give each redemption of the same ID-JAG a grant of its own', async () => {
    const { c, stores } = await providerContext();
    const assertion = await idJag(await trustPartnerIdp());

    const first = (await (await redeemIdJag(c, redemptionRequest(assertion), client))!.json()) as { access_token: string };
    const second = (await (await redeemIdJag(c, redemptionRequest(assertion), client))!.json()) as { access_token: string };

    const grantIds = [
      (await stores.accessTokenStore.get(first.access_token))!.grantId,
      (await stores.accessTokenStore.get(second.access_token))!.grantId,
    ];
    expect(grantIds[0]).not.toBe(grantIds[1]);
  });

  // RFC 8707: the resource of the ID-JAG joins the audience. RFC 8693 §4.1: act is preserved.
  it('should add the resource of the ID-JAG to the audience and keep its act claim on the token and the record', async () => {
    const { c, stores } = await providerContext();
    const assertion = await idJag(await trustPartnerIdp(), {
      resource: 'https://api.example.com',
      act: { sub: 'agent-1' },
    });

    const response = await redeemIdJag(c, redemptionRequest(assertion), client);

    const { access_token: accessToken } = (await response!.json()) as { access_token: string };
    expect(await stores.accessTokenStore.get(accessToken)).toMatchObject({
      audience: [USERINFO, 'https://api.example.com'],
      act: { sub: 'agent-1' },
    });
    expect(decodeJwt(accessToken).payload).toMatchObject({
      aud: [USERINFO, 'https://api.example.com'],
      act: { sub: 'agent-1' },
    });
  });

  it('should issue an opaque access token when accessTokenFormat is opaque', async () => {
    const { c, stores } = await providerContext({ options: { config: { accessTokenFormat: 'opaque' } } });
    const assertion = await idJag(await trustPartnerIdp());

    const response = await redeemIdJag(c, redemptionRequest(assertion), client);

    const { access_token: accessToken } = (await response!.json()) as { access_token: string };
    expect(accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await stores.accessTokenStore.get(accessToken)).toMatchObject({ sub: 'alice@partner', scope: ['calendar.read'] });
  });

  // ID-JAG draft §9.4: an untrusted issuer and a bad signature are answered alike, so the trust list stays private.
  it('should reject an ID-JAG of an untrusted issuer and one with a bad signature alike with invalid_grant', async () => {
    const { c } = await providerContext();
    const partnerKey = await trustPartnerIdp();
    const strangerKey = await rs256Key('stranger-key');

    const untrusted = await failureOf(
      redeemIdJag(c, redemptionRequest(await idJag(partnerKey, { iss: 'https://idp.stranger.example' })), client),
    );
    const badSignature = await failureOf(redeemIdJag(c, redemptionRequest(await idJag(strangerKey)), client));

    const expected = { status: 400, body: { error: 'invalid_grant', error_description: ASSERTION_UNTRUSTED_DESCRIPTION } };
    expect([untrusted.response, badSignature.response]).toEqual([expected, expected]);
  });

  it('should reject every ID-JAG while no identity provider is trusted', async () => {
    const { c } = await providerContext();
    const assertion = await idJag(await rs256Key('partner-idp-key'));

    const error = await failureOf(redeemIdJag(c, redemptionRequest(assertion), client));

    expect(error.response.body).toEqual({ error: 'invalid_grant', error_description: ASSERTION_UNTRUSTED_DESCRIPTION });
  });

  it('should reject a client that is not registered for the jwt-bearer grant with unauthorized_client', async () => {
    const { c } = await providerContext();
    const assertion = await idJag(await trustPartnerIdp());

    const error = await failureOf(
      redeemIdJag(c, redemptionRequest(assertion), { ...client, grantTypes: ['authorization_code'] }),
    );

    expect(error.response).toEqual({
      status: 400,
      body: { error: 'unauthorized_client', error_description: 'The client is not authorized to use the jwt-bearer grant type' },
    });
  });
});
