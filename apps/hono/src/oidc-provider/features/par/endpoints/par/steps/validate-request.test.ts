import { ParError } from '@maronn-openid-connect/experimental/par';
import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../../../test-support/context.js';
import { TEST_CODE_CHALLENGE } from '../../../../../../test-support/feature-endpoints.js';
import type { ProviderConfig } from '../../../../../config.js';
import { registerClient } from '../../../../../db/memory/clients.js';
import { validatePushedRequest } from './validate-request.js';

const REDIRECT_URI = 'https://rp.example.com/callback';

async function contextWithClient(config: Partial<ProviderConfig> = {}) {
  const context = await providerContext({ options: { config } });
  await registerClient(context.db, {
    clientId: 'client-1',
    clientSecret: 'secret-1',
    clientType: 'confidential',
    redirectUris: [REDIRECT_URI],
  });
  return context;
}

function pushedParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    client_id: 'client-1',
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'openid',
    code_challenge: TEST_CODE_CHALLENGE,
    code_challenge_method: 'S256',
    ...overrides,
  };
}

describe('validatePushedRequest', () => {
  // RFC 9126 §2.1: validate the request as the authorization endpoint would.
  it('should accept a request the authorization endpoint would accept', async () => {
    const { c } = await contextWithClient();

    await expect(validatePushedRequest(c, pushedParams())).resolves.toBeUndefined();
  });

  it('should reject a redirect_uri the client did not register with invalid_request', async () => {
    const { c } = await contextWithClient();

    const validating = validatePushedRequest(c, pushedParams({ redirect_uri: 'https://attacker.example.com/cb' }));

    await expect(validating).rejects.toBeInstanceOf(ParError);
    await expect(validating).rejects.toMatchObject({
      code: 'invalid_request',
      errorDescription: 'redirect_uri not registered',
      statusCode: 400,
    });
  });

  // OIDC Core 1.0 §3.1.2.2 / RFC 9126 §2.1: a request without openid is an OAuth 2.0
  // request, accepted here as the authorization endpoint accepts it.
  it('should accept a scope without openid as an OAuth 2.0 request', async () => {
    const { c } = await contextWithClient();

    await expect(validatePushedRequest(c, pushedParams({ scope: 'reports.read' }))).resolves.toBeUndefined();
  });

  // OIDC Core 1.0 §3.1.2.1: with requireOpenIdScope, scope MUST contain openid.
  it('should reject a scope without openid with invalid_scope when requireOpenIdScope is set', async () => {
    const { c } = await contextWithClient({ requireOpenIdScope: true });

    await expect(validatePushedRequest(c, pushedParams({ scope: 'profile' }))).rejects.toMatchObject({
      code: 'invalid_scope',
      errorDescription: 'scope must include openid',
    });
  });

  it('should reject a response_type other than code with unsupported_response_type', async () => {
    const { c } = await contextWithClient();

    await expect(validatePushedRequest(c, pushedParams({ response_type: 'token' }))).rejects.toMatchObject({
      code: 'unsupported_response_type',
    });
  });

  describe('PKCE', () => {
    // OAuth 2.1 §4.1.1: the pkce feature requires PKCE of confidential clients too.
    it('should reject a confidential client that omits PKCE with invalid_request', async () => {
      const { c } = await contextWithClient();
      const { code_challenge: _challenge, code_challenge_method: _method, ...withoutPkce } = pushedParams();

      await expect(validatePushedRequest(c, withoutPkce)).rejects.toMatchObject({
        code: 'invalid_request',
        errorDescription: 'Missing required parameter: code_challenge',
      });
    });

    it('should accept a confidential client that omits PKCE when allowNonPkceAuthorizationCodeFlow is on', async () => {
      const { c } = await contextWithClient({ allowNonPkceAuthorizationCodeFlow: true });
      const { code_challenge: _challenge, code_challenge_method: _method, ...withoutPkce } = pushedParams();

      await expect(validatePushedRequest(c, withoutPkce)).resolves.toBeUndefined();
    });
  });
});
