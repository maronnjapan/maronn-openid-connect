import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import { authorizationCodeRequest, refreshTokenRequest } from '../../../../test-support/token.js';
import { buildTokenResponse } from './build-token-response.js';

describe('buildTokenResponse', () => {
  // OIDC Core 1.0 §3.1.3.3 / RFC 6749 §5.1: access_token, token_type, expires_in, id_token, scope, refresh_token.
  it('should build a 200 Bearer response with every issued token, expires_in and the space-separated scope', async () => {
    const { c } = await providerContext({ options: { config: { accessTokenExpiresIn: 900 } } });

    expect(
      buildTokenResponse(c, {
        accessToken: 'at-1',
        idToken: 'id-token-1',
        refreshToken: 'rt-1',
        validatedRequest: authorizationCodeRequest({ scope: ['openid', 'profile', 'offline_access'] }),
      }),
    ).toEqual({
      status: 200,
      body: {
        access_token: 'at-1',
        token_type: 'Bearer',
        expires_in: 900,
        id_token: 'id-token-1',
        scope: 'openid profile offline_access',
        refresh_token: 'rt-1',
      },
    });
  });

  // RFC 6749 §5.1: refresh_token is OPTIONAL; OIDC Core 1.0 §12.2: so is the ID Token of a refresh.
  it('should leave id_token and refresh_token out of the JSON body when neither was issued', async () => {
    const { c } = await providerContext();

    const response = buildTokenResponse(c, {
      accessToken: 'at-2',
      idToken: undefined,
      validatedRequest: refreshTokenRequest({ scope: ['profile'] }),
    });

    expect(JSON.parse(JSON.stringify(response.body))).toEqual({
      access_token: 'at-2',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'profile',
    });
  });
});
