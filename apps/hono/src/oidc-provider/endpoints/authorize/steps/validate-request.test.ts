import type { ClientInfo } from '@maronn-openid-connect/core';
import { describe, expect, it, vi } from 'vitest';
import {
  authorizationParams,
  CLIENT_ID,
  CODE_CHALLENGE,
  NONCE,
  REDIRECT_URI,
  STATE,
} from '../../../../test-support/authorize.js';
import { providerContext } from '../../../../test-support/context.js';
import { findUnsupportedScopes } from '../../../scopes.js';
import type { AuthorizationRequestInput } from '../outcome.js';
import { validateAuthorizationRequestParams } from './validate-request.js';

// The provider declares no custom scope (CUSTOM_SCOPES in scopes.ts is
// empty), so the allow-list check never rejects anything. It is replaced by
// a spy that behaves the same until a test says otherwise.
vi.mock('../../../scopes.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../scopes.js')>();
  return { ...original, findUnsupportedScopes: vi.fn(original.findUnsupportedScopes) };
});

const client: ClientInfo = {
  clientId: CLIENT_ID,
  clientType: 'confidential',
  redirectUris: [REDIRECT_URI],
  grantTypes: ['authorization_code'],
};

/** Validate the parameters as the pipeline does after redirect_uri was resolved. */
async function validate(
  params: AuthorizationRequestInput,
  input: {
    effectiveParams?: AuthorizationRequestInput;
    requestObjectClaims?: Record<string, unknown>;
    client?: ClientInfo;
  } = {},
) {
  const { c } = await providerContext();
  return validateAuthorizationRequestParams(c, {
    params,
    effectiveParams: input.effectiveParams,
    requestObjectClaims: input.requestObjectClaims,
    client: input.client ?? client,
    redirectUri: REDIRECT_URI,
    state: STATE,
  });
}

function paramsWith(overrides: Record<string, string> = {}): AuthorizationRequestInput {
  return authorizationParams(overrides) as AuthorizationRequestInput;
}

describe('validateAuthorizationRequestParams', () => {
  describe('Validated request', () => {
    // OIDC Core 1.0 §3.1.2.1: every parameter the request carries, parsed.
    it('should assemble the validated request from every parameter of the request', async () => {
      const params = paramsWith({
        scope: 'openid profile openid',
        prompt: 'login consent',
        display: 'popup',
        max_age: '300',
        ui_locales: 'ja en',
        claims_locales: 'en',
        acr_values: 'urn:acr:a  urn:acr:b',
        login_hint: 'alice@example.com',
        audience: 'https://api.example.com https://api2.example.com',
        claims: JSON.stringify({ id_token: { email: { essential: true } } }),
      });

      expect(await validate(params)).toEqual({
        responseType: 'code',
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        redirectUriExplicit: true,
        scope: ['openid', 'profile'],
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: 'S256',
        state: STATE,
        nonce: NONCE,
        prompt: ['login', 'consent'],
        display: 'popup',
        maxAge: 300,
        uiLocales: 'ja en',
        claimsLocales: 'en',
        acrValues: 'urn:acr:a urn:acr:b',
        loginHint: 'alice@example.com',
        idTokenHint: undefined,
        audience: ['https://api.example.com', 'https://api2.example.com'],
        claims: { id_token: { email: { essential: true } } },
      });
    });

    // OIDC Core 1.0 §3.1.3.2: the token request repeats redirect_uri only when
    // the authorization request sent it.
    it('should set redirectUriExplicit to false when the request left redirect_uri out', async () => {
      const params = paramsWith();
      delete params.redirect_uri;

      expect(await validate(params)).toMatchObject({ redirectUri: REDIRECT_URI, redirectUriExplicit: false });
    });

    // OIDC Core 1.0 §6.1: the Request Object's values supersede the query.
    it('should read the parameters of the Request Object overlay instead of the query', async () => {
      const params = paramsWith({ request: 'signed-request-object', max_age: '600' });

      const validated = await validate(params, {
        effectiveParams: { ...params, nonce: 'nonce-from-request-object', max_age: '60' },
        requestObjectClaims: { nonce: 'nonce-from-request-object', max_age: 60 },
      });

      expect(validated).toMatchObject({ nonce: 'nonce-from-request-object', maxAge: 60 });
    });
  });

  // RFC 6749 §4.1.2.1: every failure here goes back to the redirect_uri with the state.
  describe('Redirectable errors', () => {
    // OIDC Core 1.0 §6.3: without the request-object overlay the request parameter is not supported.
    it('should reject the request parameter with request_not_supported when there is no Request Object overlay', async () => {
      await expect(validate(paramsWith({ request: 'signed-request-object' }))).rejects.toMatchObject({
        error: 'request_not_supported',
        errorDescription: 'request parameter (Request Object) is not supported',
        redirectUri: REDIRECT_URI,
        state: STATE,
      });
    });

    // OAuth 2.1 §4.1.1 / §7.5: the pkce feature requires PKCE of confidential clients too.
    it('should reject a request of a confidential client without code_challenge with invalid_request', async () => {
      const params = paramsWith();
      delete params.code_challenge;
      delete params.code_challenge_method;

      await expect(validate(params)).rejects.toMatchObject({
        error: 'invalid_request',
        errorDescription: 'Missing required parameter: code_challenge',
        redirectUri: REDIRECT_URI,
        state: STATE,
      });
    });

    // OIDC Core 1.0 §3.1.2.1: scope MUST contain openid.
    it('should reject a scope without openid with invalid_scope', async () => {
      await expect(validate(paramsWith({ scope: 'profile' }))).rejects.toMatchObject({
        error: 'invalid_scope',
        errorDescription: 'scope must include openid',
        redirectUri: REDIRECT_URI,
        state: STATE,
      });
    });

    // RFC 7591 §2: a client registered with a scope list may request only those.
    it('should reject a scope the client is not registered for with invalid_scope', async () => {
      const limited: ClientInfo = { ...client, scope: ['openid'] };

      await expect(validate(paramsWith({ scope: 'openid email' }), { client: limited })).rejects.toMatchObject({
        error: 'invalid_scope',
        errorDescription: 'Client is not registered for scope: email',
        redirectUri: REDIRECT_URI,
        state: STATE,
      });
    });

    // RFC 6749 §3.3 / §4.1.2.1: a value outside the declared scopes is invalid_scope.
    it('should reject a scope the scope policy does not accept with invalid_scope', async () => {
      vi.mocked(findUnsupportedScopes).mockReturnValueOnce(['reports.read']);

      await expect(validate(paramsWith({ scope: 'openid reports.read' }))).rejects.toMatchObject({
        error: 'invalid_scope',
        errorDescription: 'Unsupported scope: reports.read',
        redirectUri: REDIRECT_URI,
        state: STATE,
      });
    });
  });

  // OIDC Core 1.0 §3.2.2.1: the Implicit Flow feature answers id_token and
  // id_token token for a client registered for them.
  describe('Implicit Flow', () => {
    const implicitClient: ClientInfo = {
      ...client,
      grantTypes: ['implicit', 'refresh_token'],
      responseTypes: ['id_token token', 'id_token'],
    };

    // OAuth 2.0 Multiple Response Type Encoding Practices §1.2: the order of
    // the values does not matter. PKCE protects the authorization code (RFC
    // 7636 §1), and this response type returns none.
    it('should accept response_type=token id_token without code_challenge as id_token token', async () => {
      const params = paramsWith({ response_type: 'token id_token' });
      delete params.code_challenge;
      delete params.code_challenge_method;

      const validated = await validate(params, { client: implicitClient });

      expect(validated).toMatchObject({
        responseType: 'id_token token',
        codeChallenge: undefined,
        codeChallengeMethod: undefined,
        nonce: NONCE,
      });
    });

    // RFC 6749 §4.2.2.1: a client not registered for the response type.
    it('should reject response_type=id_token of a client registered only for code with unauthorized_client', async () => {
      await expect(validate(paramsWith({ response_type: 'id_token' }))).rejects.toMatchObject({
        error: 'unauthorized_client',
        errorDescription: 'Client is not authorized to use response_type: id_token',
        redirectUri: REDIRECT_URI,
        state: STATE,
      });
    });

    // RFC 6749 §4.2.2.1: the OP does not answer token alone (OIDC Core 1.0
    // §3.2.2.1 names id_token and id_token token).
    it('should reject response_type=token with unsupported_response_type', async () => {
      await expect(validate(paramsWith({ response_type: 'token' }), { client: implicitClient })).rejects.toMatchObject({
        error: 'unsupported_response_type',
        errorDescription: 'Unsupported response_type: token',
        redirectUri: REDIRECT_URI,
        state: STATE,
      });
    });

    // OIDC Core 1.0 §11: offline_access is ignored unless the response type returns a code.
    it('should drop offline_access from a request of id_token token, even with prompt=consent', async () => {
      const validated = await validate(
        paramsWith({ response_type: 'id_token token', scope: 'openid offline_access', prompt: 'consent' }),
        { client: implicitClient },
      );

      expect(validated.scope).toEqual(['openid']);
    });
  });

  // OIDC Core 1.0 §3.3.1.1: the Hybrid Flow feature answers code id_token,
  // code token and code id_token token for a client registered for them.
  describe('Hybrid Flow', () => {
    const hybridClient: ClientInfo = {
      ...client,
      grantTypes: ['authorization_code', 'implicit', 'refresh_token'],
      responseTypes: ['code id_token token', 'code id_token', 'code token'],
    };

    // OAuth 2.0 Multiple Response Type Encoding Practices §1.2: the order of
    // the values does not matter. PKCE binds the code the response returns.
    it('should accept response_type=token id_token code with code_challenge as code id_token token', async () => {
      const validated = await validate(paramsWith({ response_type: 'token id_token code' }), { client: hybridClient });

      expect(validated).toMatchObject({
        responseType: 'code id_token token',
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: 'S256',
        nonce: NONCE,
      });
    });

    // OAuth 2.1 §4.1.1 / §7.5: the code of the Hybrid Flow needs PKCE like any code.
    it('should reject response_type=code id_token without code_challenge with invalid_request', async () => {
      const params = paramsWith({ response_type: 'code id_token' });
      delete params.code_challenge;
      delete params.code_challenge_method;

      await expect(validate(params, { client: hybridClient })).rejects.toMatchObject({
        error: 'invalid_request',
        errorDescription: 'Missing required parameter: code_challenge',
        redirectUri: REDIRECT_URI,
        state: STATE,
      });
    });

    // OIDC Core 1.0 §11: the code returns a refresh token, so offline_access
    // is granted under the rules of the code flow.
    it('should keep offline_access for a request of code id_token with prompt=consent', async () => {
      const validated = await validate(
        paramsWith({ response_type: 'code id_token', scope: 'openid offline_access', prompt: 'consent' }),
        { client: hybridClient },
      );

      expect(validated.scope).toEqual(['openid', 'offline_access']);
    });

    // RFC 6749 §4.1.2.1: a client not registered for the response type.
    it('should reject response_type=code id_token of a client registered only for code with unauthorized_client', async () => {
      await expect(validate(paramsWith({ response_type: 'code id_token' }))).rejects.toMatchObject({
        error: 'unauthorized_client',
        errorDescription: 'Client is not authorized to use response_type: code id_token',
        redirectUri: REDIRECT_URI,
        state: STATE,
      });
    });
  });

  // OIDC Core 1.0 §11: offline_access needs prompt=consent and a client
  // registered for the refresh_token grant; otherwise it is ignored.
  describe('offline_access', () => {
    const refreshClient: ClientInfo = { ...client, grantTypes: ['authorization_code', 'refresh_token'] };

    it('should drop offline_access when the request does not ask for prompt=consent', async () => {
      const validated = await validate(paramsWith({ scope: 'openid offline_access' }), { client: refreshClient });

      expect(validated.scope).toEqual(['openid']);
    });

    it('should keep offline_access with prompt=consent for a client registered for refresh_token', async () => {
      const validated = await validate(paramsWith({ scope: 'openid offline_access', prompt: 'consent' }), {
        client: refreshClient,
      });

      expect(validated.scope).toEqual(['openid', 'offline_access']);
    });
  });
});
