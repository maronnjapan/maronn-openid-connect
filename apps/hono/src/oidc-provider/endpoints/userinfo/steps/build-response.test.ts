import type { AccessTokenInfo } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import { decodeJwt, verifiesWithRs256 } from '../../../../test-support/screens.js';
import type { ClientRegistration } from '../../../config.js';
import { registerClient } from '../../../db/memory/clients.js';
import { UserInfoEndpointError } from '../response.js';
import { buildUserInfoResponse } from './build-response.js';

const claims = { sub: 'alice', email: 'alice@example.com' };

function tokenInfo(clientId: string): AccessTokenInfo {
  return { sub: 'alice', scope: ['openid', 'email'], clientId, expiresAt: 0 };
}

function client(clientId: string, userinfoSignedResponseAlg?: 'RS256' | 'ES256'): ClientRegistration {
  return {
    clientId,
    redirectUris: ['https://rp.example.com/callback'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethods: ['none'],
    ...(userinfoSignedResponseAlg ? { userinfoSignedResponseAlg } : {}),
  };
}

describe('buildUserInfoResponse', () => {
  it('should answer JSON for a client that registered no userinfo_signed_response_alg', async () => {
    const { c, db } = await providerContext();
    await registerClient(db, client('json-client'));

    expect(await buildUserInfoResponse(c, tokenInfo('json-client'), claims)).toEqual({ status: 200, body: claims });
  });

  it('should answer JSON when the client of the token is no longer registered', async () => {
    const { c } = await providerContext();

    expect(await buildUserInfoResponse(c, tokenInfo('gone-client'), claims)).toEqual({ status: 200, body: claims });
  });

  // OIDC Core 1.0 §5.3.2: a signed UserInfo response carries iss and aud.
  it('should answer a JWT signed with the registered alg for a client that asked for one', async () => {
    const { c, db, signingKey } = await providerContext();
    await registerClient(db, client('jwt-client', 'RS256'));

    const response = await buildUserInfoResponse(c, tokenInfo('jwt-client'), claims);
    const jwt = response.text ?? '';

    expect(response).toMatchObject({ status: 200, headers: { 'Content-Type': 'application/jwt' } });
    expect(response.body).toBeUndefined();
    expect(decodeJwt(jwt)).toMatchObject({
      header: { alg: 'RS256', typ: 'JWT', kid: 'test-rs256-key' },
      payload: { sub: 'alice', email: 'alice@example.com', iss: 'https://op.example.com', aud: 'jwt-client' },
    });
    expect(await verifiesWithRs256(jwt, signingKey)).toBe(true);
  });

  it('should fail with server_error when no UserInfo key has the registered alg', async () => {
    const { c, db } = await providerContext();
    await registerClient(db, client('es-client', 'ES256'));

    const rejection = buildUserInfoResponse(c, tokenInfo('es-client'), claims);

    await expect(rejection).rejects.toBeInstanceOf(UserInfoEndpointError);
    await expect(rejection).rejects.toMatchObject({
      response: {
        status: 500,
        body: { error: 'server_error', error_description: 'No UserInfo signing key registered for alg "ES256"' },
      },
    });
  });
});
