import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, providerContext } from '../../../../test-support/context.js';
import {
  CLIENT_ID,
  NOW,
  SUBJECT,
  authorizationCodeRequest,
  refreshTokenRequest,
} from '../../../../test-support/token.js';
import { persistAccessToken } from './persist-access-token.js';

const AUDIENCE = [`${TEST_ISSUER}/userinfo`];
const CLAIMS = { userinfo: { name: { essential: true } } };

describe('persistAccessToken', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // RFC 7662 §2.2 / OIDC Core 1.0 §5.5: the record introspection and UserInfo read.
  it('should store the access token record with the claims request of an authorization_code grant', async () => {
    const { c, stores } = await providerContext({ options: { config: { accessTokenExpiresIn: 600 } } });

    await persistAccessToken(c, {
      accessToken: 'at-1',
      accessTokenPayload: { jti: 'jti-1' },
      subject: SUBJECT,
      validatedRequest: authorizationCodeRequest({ claims: CLAIMS }),
      issuedAt: NOW,
      audience: AUDIENCE,
      acr: 'urn:acr:mfa',
    });

    expect(await stores.accessTokenStore.get('at-1')).toEqual({
      sub: SUBJECT,
      clientId: CLIENT_ID,
      scope: ['openid', 'profile'],
      expiresAt: NOW + 600,
      grantId: 'grant-1',
      iat: NOW,
      nbf: NOW,
      audience: AUDIENCE,
      issuer: TEST_ISSUER,
      jti: 'jti-1',
      claims: CLAIMS,
      acr: 'urn:acr:mfa',
    });
  });

  // OIDC Core 1.0 §5.5: a refresh has no authorization request, so there is no claims request to keep.
  it('should store no claims request for a refresh_token grant', async () => {
    const { c, stores } = await providerContext();

    await persistAccessToken(c, {
      accessToken: 'at-2',
      accessTokenPayload: { jti: 'jti-2' },
      subject: SUBJECT,
      validatedRequest: refreshTokenRequest({ scope: ['openid'] }),
      issuedAt: NOW,
      audience: AUDIENCE,
      acr: undefined,
    });

    expect(await stores.accessTokenStore.get('at-2')).toEqual({
      sub: SUBJECT,
      clientId: CLIENT_ID,
      scope: ['openid'],
      expiresAt: NOW + 3600,
      grantId: 'grant-1',
      iat: NOW,
      nbf: NOW,
      audience: AUDIENCE,
      issuer: TEST_ISSUER,
      jti: 'jti-2',
    });
  });

  // RFC 9449 §6.2: the record keeps the confirmation and the token_type, which an opaque token does not carry itself.
  it('should store the cnf and the token_type of the binding with the record of a bound token', async () => {
    const { c, stores } = await providerContext();

    await persistAccessToken(c, {
      accessToken: 'at-3',
      accessTokenPayload: { jti: 'jti-3' },
      subject: SUBJECT,
      validatedRequest: refreshTokenRequest({ scope: ['openid'] }),
      issuedAt: NOW,
      audience: AUDIENCE,
      acr: undefined,
      binding: { cnf: { jkt: 'jkt-1' }, tokenType: 'DPoP' },
    });

    expect(await stores.accessTokenStore.get('at-3')).toEqual({
      sub: SUBJECT,
      clientId: CLIENT_ID,
      scope: ['openid'],
      expiresAt: NOW + 3600,
      grantId: 'grant-1',
      iat: NOW,
      nbf: NOW,
      audience: AUDIENCE,
      issuer: TEST_ISSUER,
      jti: 'jti-3',
      cnf: { jkt: 'jkt-1' },
      tokenType: 'DPoP',
    });
  });
});
