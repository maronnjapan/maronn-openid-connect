import { describe, it, expect, beforeAll } from 'vitest';
import {
  validateAuthorizationRequest,
  validateRegisteredRedirectUris,
  AuthorizationError,
  AuthorizationErrorCode,
  DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH,
} from './authorization-request.js';
import type {
  AuthorizationRequestParams,
  ClientInfo,
  ClientResolver,
  ValidateAuthorizationRequestOptions,
} from './authorization-request.js';
import { exportPublicJwk } from './jwks.js';
import type { JwkSet } from './jwks.js';
import { sign, arrayBufferToBase64Url, stringToArrayBuffer } from './crypto-utils.js';

// Helpers for building compact-JWS Request Objects (OIDC Core 1.0 §6.1).
function encodeSegment(value: unknown): string {
  return arrayBufferToBase64Url(stringToArrayBuffer(JSON.stringify(value)));
}

async function buildSignedRequestObject(
  claims: Record<string, unknown>,
  privateKey: CryptoKey,
  kid?: string,
  alg = 'RS256',
): Promise<string> {
  const header: Record<string, unknown> = { alg, typ: 'oauth-authz-req+jwt' };
  if (kid !== undefined) header.kid = kid;
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  const signature = await sign(signingInput, privateKey);
  return `${signingInput}.${signature}`;
}

function buildUnsignedRequestObject(claims: Record<string, unknown>): string {
  // RFC 7515 §6: the "none" algorithm has an empty signature segment.
  return `${encodeSegment({ alg: 'none' })}.${encodeSegment(claims)}.`;
}

function buildRequestObjectWithAlg(
  alg: string,
  claims: Record<string, unknown>,
): string {
  return `${encodeSegment({ alg })}.${encodeSegment(claims)}.AAAA`;
}

// Helper: create a ClientResolver from an array of clients
function createClientResolver(clients: ClientInfo[]): ClientResolver {
  return {
    findClient: async (clientId: string): Promise<ClientInfo | null> => {
      return clients.find((c) => c.clientId === clientId) ?? null;
    },
  };
}

// Default valid client
const defaultClient: ClientInfo = {
  clientId: 'client123',
  redirectUris: ['https://client.example.org/cb'],
};

// RFC 7591 §2: grant_types の既定は ["authorization_code"]。offline_access は
// refresh_token grant を登録したクライアントにしか付与されないため、offline_access を
// 扱うテストはこのクライアントを使う。
const refreshGrantClient: ClientInfo = {
  clientId: 'client123',
  redirectUris: ['https://client.example.org/cb'],
  grantTypes: ['authorization_code', 'refresh_token'],
};

// Default valid parameters (PKCE required in OAuth 2.1)
function validParams(
  overrides?: Partial<AuthorizationRequestParams>
): AuthorizationRequestParams {
  return {
    response_type: 'code',
    client_id: 'client123',
    redirect_uri: 'https://client.example.org/cb',
    scope: 'openid',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    ...overrides,
  };
}

// Helper: validate with a resolver built from `clients` (default: the default client),
// or with an explicit ClientResolver
function validate(
  params: AuthorizationRequestParams,
  clients: ClientInfo[] | ClientResolver = [defaultClient],
  options?: ValidateAuthorizationRequestOptions,
) {
  const resolver = Array.isArray(clients) ? createClientResolver(clients) : clients;
  return validateAuthorizationRequest(params, resolver, options);
}

// Helper: validate expecting an AuthorizationError, and return it for further assertions
async function expectAuthorizationError(
  params: AuthorizationRequestParams,
  clients: ClientInfo[] | ClientResolver = [defaultClient],
  options?: ValidateAuthorizationRequestOptions,
): Promise<AuthorizationError> {
  const error = await validate(params, clients, options).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AuthorizationError);
  return error as AuthorizationError;
}

describe('validateAuthorizationRequest', () => {
  describe('ClientResolver integration', () => {
    it('should call findClient with the client_id from the request', async () => {
      let capturedClientId: string | undefined;
      const resolver: ClientResolver = {
        findClient: async (clientId) => {
          capturedClientId = clientId;
          return defaultClient;
        },
      };

      await validate(validParams(), resolver);

      expect(capturedClientId).toEqual('client123');
    });

    it('should detect clientId mismatch between request and resolver response', async () => {
      const buggyResolver: ClientResolver = {
        findClient: async () => {
          return {
            clientId: 'different-client',
            redirectUris: ['https://client.example.org/cb'],
          };
        },
      };

      const error = await expectAuthorizationError(validParams(), buggyResolver);
      expect(error).toMatchObject({
        redirectable: false,
        error: AuthorizationErrorCode.ServerError,
      });
    });
  });

  describe('client_id validation', () => {
    it('should accept valid client_id', async () => {
      const result = await validate(validParams());

      expect(result.clientId).toEqual('client123');
    });

    it('should reject missing client_id', async () => {
      const params: AuthorizationRequestParams = {
        response_type: 'code',
        redirect_uri: 'https://client.example.org/cb',
        scope: 'openid',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      };

      const error = await expectAuthorizationError(params);
      expect(error.redirectable).toBe(false);
    });

    it('should return non-redirectable error for unknown client_id', async () => {
      const error = await expectAuthorizationError(validParams({ client_id: 'unknown-client' }));
      expect(error.redirectable).toBe(false);
      expect(error.redirectUri).toBeUndefined();
    });
  });

  describe('redirect_uri validation', () => {
    it('should accept registered redirect_uri', async () => {
      const result = await validate(validParams());

      expect(result.redirectUri).toEqual('https://client.example.org/cb');
    });

    // OP-redirect_uri-NotReg: Reject unregistered URIs
    it('should return non-redirectable error for unregistered redirect_uri', async () => {
      const error = await expectAuthorizationError(
        validParams({ redirect_uri: 'https://evil.example.com/cb' }),
      );
      expect(error.redirectable).toBe(false);
      expect(error.redirectUri).toBeUndefined();
      expect(error.error).toEqual(AuthorizationErrorCode.InvalidRequest);
    });

    it('should use single registered redirect_uri when omitted from request', async () => {
      const params = validParams({ redirect_uri: undefined });

      const result = await validate(params);

      expect(result.redirectUri).toEqual('https://client.example.org/cb');
    });

    // OP-redirect_uri-Missing: Require redirect_uri when multiple registered
    it('should reject missing redirect_uri when multiple URIs are registered', async () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: [
          'https://client.example.org/cb1',
          'https://client.example.org/cb2',
        ],
      };
      const params = validParams({ redirect_uri: undefined });

      const error = await expectAuthorizationError(params, [client]);
      expect(error.redirectable).toBe(false);
    });

    // Exact string matching - RFC 3986 Section 6.2.1
    it('should use exact string matching for redirect_uri', async () => {
      await expectAuthorizationError(
        validParams({ redirect_uri: 'https://client.example.org/cb/' }),
      );
    });

    // OP-redirect_uri-RegFrag: Reject fragments
    it('should reject redirect_uri with fragment', async () => {
      const error = await expectAuthorizationError(
        validParams({ redirect_uri: 'https://client.example.org/cb#fragment' }),
      );
      expect(error.redirectable).toBe(false);
    });

    // OP-redirect_uri-RegFrag: Reject when REGISTERED redirect_uri contains fragment
    // OIDC Core 1.0 Section 3.1.2.1: redirect_uri MUST NOT include a fragment component
    it('should throw server_error when registered redirect_uri contains fragment', async () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['https://client.example.org/cb#bad-fragment'],
      };

      const error = await expectAuthorizationError(
        validParams({ redirect_uri: 'https://client.example.org/cb#bad-fragment' }),
        [client],
      );
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.ServerError,
        redirectable: false,
      });
    });

    it('should throw server_error when any registered redirect_uri contains fragment', async () => {
      // Even when the request omits redirect_uri, registered URIs with fragment must be rejected.
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: [
          'https://client.example.org/cb',
          'https://client.example.org/other#bad',
        ],
      };

      const error = await expectAuthorizationError(
        validParams({ redirect_uri: 'https://client.example.org/cb' }),
        [client],
      );
      expect(error.error).toEqual(AuthorizationErrorCode.ServerError);
    });

    // OP-redirect_uri-Query-OK: Preserve registered query parameters
    it('should accept redirect_uri with matching registered query parameters', async () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['https://client.example.org/cb?mode=auth'],
      };

      const result = await validate(
        validParams({ redirect_uri: 'https://client.example.org/cb?mode=auth' }),
        [client],
      );

      expect(result.redirectUri).toEqual('https://client.example.org/cb?mode=auth');
    });

    // OP-redirect_uri-Query-Mismatch: Reject mismatched query parameters
    it('should reject redirect_uri with mismatched query parameters', async () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['https://client.example.org/cb?mode=auth'],
      };

      await expectAuthorizationError(
        validParams({ redirect_uri: 'https://client.example.org/cb?mode=other' }),
        [client],
      );
    });

    // OP-redirect_uri-Query-Added: Reject added query parameters
    it('should reject redirect_uri with added query parameters', async () => {
      await expectAuthorizationError(
        validParams({ redirect_uri: 'https://client.example.org/cb?extra=param' }),
      );
    });

    // Loopback exception: allow variable port numbers (public clients only)
    // OAuth 2.1 Section 10.3.3
    it('should allow different port for loopback redirect_uri when client is public', async () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['http://127.0.0.1/callback'],
        clientType: 'public',
      };

      const result = await validate(
        validParams({ redirect_uri: 'http://127.0.0.1:8080/callback' }),
        [client],
      );

      expect(result.redirectUri).toEqual('http://127.0.0.1:8080/callback');
    });

    it('should allow different port for localhost redirect_uri when client is public', async () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['http://localhost/callback'],
        clientType: 'public',
      };

      const result = await validate(
        validParams({ redirect_uri: 'http://localhost:9000/callback' }),
        [client],
      );

      expect(result.redirectUri).toEqual('http://localhost:9000/callback');
    });

    // OAuth 2.1 Section 10.3.3: ループバックポート許容は public client 限定。
    // confidential client は厳格一致 (登録ポートと一致しなければ不一致)。
    it('should reject different port for loopback redirect_uri when client is confidential', async () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['http://127.0.0.1/callback'],
        clientType: 'confidential',
      };

      const error = await expectAuthorizationError(
        validParams({ redirect_uri: 'http://127.0.0.1:8080/callback' }),
        [client],
      );
      expect(error.error).toEqual(AuthorizationErrorCode.InvalidRequest);
    });

    it('should reject different port for loopback redirect_uri when clientType is unspecified (defaults to strict)', async () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['http://127.0.0.1/callback'],
      };

      const error = await expectAuthorizationError(
        validParams({ redirect_uri: 'http://127.0.0.1:8080/callback' }),
        [client],
      );
      expect(error.error).toEqual(AuthorizationErrorCode.InvalidRequest);
    });
  });

  describe('response_type validation', () => {
    // OP-Response-code: Request with response_type=code
    it('should accept response_type=code', async () => {
      const result = await validate(validParams());

      expect(result.responseType).toEqual('code');
    });

    // OP-Response-Missing: Reject missing response_type
    it('should reject missing response_type', async () => {
      const error = await expectAuthorizationError(validParams({ response_type: undefined }));
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.InvalidRequest,
        redirectable: true,
      });
    });

    it('should reject unsupported response_type', async () => {
      const error = await expectAuthorizationError(validParams({ response_type: 'token' }));
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.UnsupportedResponseType,
        redirectable: true,
      });
    });
  });

  describe('scope validation', () => {
    it('should accept scope containing openid', async () => {
      const result = await validate(validParams({ scope: 'openid profile' }));

      expect(result.scope).toContain('openid');
      expect(result.scope).toContain('profile');
    });

    it('should reject missing scope', async () => {
      const error = await expectAuthorizationError(validParams({ scope: undefined }));
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.InvalidRequest,
        redirectable: true,
      });
    });

    it('should reject scope without openid', async () => {
      const error = await expectAuthorizationError(validParams({ scope: 'profile email' }));
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.InvalidScope,
        redirectable: true,
      });
    });

    it('should parse multiple scopes into array', async () => {
      const result = await validate(validParams({ scope: 'openid profile email address phone' }));

      expect(result.scope).toEqual([
        'openid',
        'profile',
        'email',
        'address',
        'phone',
      ]);
    });

    // RFC 6749 §3.3: scope is a set. Duplicates must be canonicalized so issued
    // artifacts are deterministic and match the Token Endpoint (refresh_token grant
    // already dedups via [...new Set(...)]). Insertion order is preserved.
    it('should deduplicate repeated scope values preserving first-seen order', async () => {
      const result = await validate(validParams({ scope: 'openid openid profile' }));

      expect(result.scope).toEqual(['openid', 'profile']);
    });
  });

  // OAuth 2.1 Section 4.1.1, 7.5 - PKCE is REQUIRED
  describe('PKCE validation (OAuth 2.1)', () => {
    it('should accept valid code_challenge with S256 method', async () => {
      const result = await validate(
        validParams({
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: 'S256',
        }),
      );

      expect(result.codeChallenge).toEqual('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
      expect(result.codeChallengeMethod).toEqual('S256');
    });

    // Security: plain method is rejected to enforce S256
    it('should reject code_challenge_method=plain', async () => {
      const error = await expectAuthorizationError(
        validParams({
          code_challenge: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
          code_challenge_method: 'plain',
        }),
      );
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.InvalidRequest,
        redirectable: true,
      });
    });

    it('should reject missing code_challenge_method', async () => {
      const error = await expectAuthorizationError(
        validParams({
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: undefined,
        }),
      );
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.InvalidRequest,
        redirectable: true,
      });
    });

    // OAuth 2.1: PKCE is REQUIRED
    it('should reject missing code_challenge', async () => {
      const error = await expectAuthorizationError(validParams({ code_challenge: undefined }));
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.InvalidRequest,
        redirectable: true,
      });
    });

    it('should accept missing PKCE parameters for explicit confidential clients when compatibility mode is enabled', async () => {
      const client: ClientInfo = {
        ...defaultClient,
        clientType: 'confidential',
      };

      const result = await validate(
        validParams({
          code_challenge: undefined,
          code_challenge_method: undefined,
        }),
        [client],
        { allowNonPkceAuthorizationCodeFlow: true },
      );

      expect(result.clientId).toEqual('client123');
      expect(result.redirectUri).toEqual('https://client.example.org/cb');
      expect(result.codeChallenge).toBeUndefined();
      expect(result.codeChallengeMethod).toBeUndefined();
    });

    it('should reject missing PKCE parameters for public clients even when compatibility mode is enabled', async () => {
      const client: ClientInfo = {
        ...defaultClient,
        clientType: 'public',
      };

      const error = await expectAuthorizationError(
        validParams({
          code_challenge: undefined,
          code_challenge_method: undefined,
        }),
        [client],
        { allowNonPkceAuthorizationCodeFlow: true },
      );
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.InvalidRequest,
        redirectable: true,
      });
    });

    it('should reject empty code_challenge', async () => {
      const error = await expectAuthorizationError(validParams({ code_challenge: '' }));
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.InvalidRequest,
        redirectable: true,
      });
    });

    it('should reject invalid code_challenge values even when compatibility mode is enabled', async () => {
      const client: ClientInfo = {
        ...defaultClient,
        clientType: 'confidential',
      };

      const error = await expectAuthorizationError(
        validParams({
          code_challenge: 'too-short',
          code_challenge_method: 'S256',
        }),
        [client],
        { allowNonPkceAuthorizationCodeFlow: true },
      );
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.InvalidRequest,
        redirectable: true,
      });
    });

    // OAuth 2.1 Section 7.5.2: MUST reject unsupported methods
    it('should reject unsupported code_challenge_method', async () => {
      const error = await expectAuthorizationError(validParams({ code_challenge_method: 'S512' }));
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.InvalidRequest,
        redirectable: true,
      });
    });

    it('should include state in PKCE error when state was provided', async () => {
      const error = await expectAuthorizationError(
        validParams({ code_challenge: undefined, state: 'my-state' }),
      );
      expect(error.state).toEqual('my-state');
    });

    // RFC 7636 Section 4.2: S256 code_challenge is BASE64URL(SHA256(...)),
    // fixed at 43 characters using only [A-Za-z0-9\-_].
    describe('code_challenge format validation (S256)', () => {
      it('should accept a 43-character base64url code_challenge', async () => {
        // 43 chars, includes both '-' and '_' base64url symbols
        const result = await validate(
          validParams({
            code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
            code_challenge_method: 'S256',
          }),
        );

        expect(result.codeChallenge).toEqual('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
      });

      it.each([
        ['shorter than 43 characters', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-c'], // 42 characters
        ['longer than 43 characters', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cMa'], // 44 characters
        ['containing non-base64url symbols', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSst+/=M'], // '+', '/', '=' are standard base64 but invalid for base64url
        ['containing punctuation such as ! or ?', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSst!?cM'],
        ['containing whitespace or newline', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSst \ncM'],
      ])('should reject a code_challenge %s', async (_reason, code_challenge) => {
        const error = await expectAuthorizationError(
          validParams({ code_challenge, code_challenge_method: 'S256' }),
        );
        expect(error).toMatchObject({ error: AuthorizationErrorCode.InvalidRequest, redirectable: true });
      });

      it('should describe the base64url and 43-character requirement in error_description', async () => {
        const error = await expectAuthorizationError(
          validParams({
            code_challenge: 'too-short',
            code_challenge_method: 'S256',
          }),
        );
        const description = error.errorDescription;
        expect(description).toContain('43');
        expect(description).toContain('base64url');
      });
    });
  });

  describe('state parameter', () => {
    it('should include state when provided', async () => {
      const result = await validate(validParams({ state: 'xyz123' }));

      expect(result.state).toEqual('xyz123');
    });

    it('should not require state', async () => {
      const result = await validate(validParams());

      expect(result.state).toBeUndefined();
    });
  });

  describe('nonce parameter', () => {
    // OP-nonce-code: nonce is optional for code flow
    it('should include nonce when provided', async () => {
      const result = await validate(validParams({ nonce: 'nonce-abc' }));

      expect(result.nonce).toEqual('nonce-abc');
    });

    // OP-nonce-NoReq-code: nonce is not required for code flow
    it('should not require nonce for code flow', async () => {
      const result = await validate(validParams());

      expect(result.nonce).toBeUndefined();
    });
  });

  describe('prompt parameter', () => {
    it.each(['none', 'login', 'consent', 'select_account'])('should accept prompt=%s', async (prompt) => {
      const result = await validate(validParams({ prompt }));

      expect(result.prompt).toEqual([prompt]);
    });

    it('should accept multiple prompt values', async () => {
      const result = await validate(validParams({ prompt: 'login consent' }));

      expect(result.prompt).toEqual(['login', 'consent']);
    });

    // OIDC Core 1.0 Section 3.1.2.1: none MUST NOT be combined with other values
    it('should reject prompt=none combined with other values', async () => {
      const error = await expectAuthorizationError(validParams({ prompt: 'none login' }));
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.InvalidRequest,
        redirectable: true,
      });
    });

    it('should reject invalid prompt value', async () => {
      const error = await expectAuthorizationError(validParams({ prompt: 'invalid_value' }));
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.InvalidRequest,
        redirectable: true,
      });
    });
  });

  describe('display parameter', () => {
    it.each(['page', 'popup', 'touch', 'wap'])('should accept display=%s', async (display) => {
      const result = await validate(validParams({ display }));

      expect(result.display).toEqual(display);
    });

    // OIDC Core 1.0 §3.1.2.1 defines display values as page/popup/touch/wap only.
    // An unrecognized value is a malformed request -> invalid_request (redirectable).
    it('should reject unknown display value with invalid_request', async () => {
      const error = await expectAuthorizationError(validParams({ display: 'custom_display' }));
      expect(error.error).toBe(AuthorizationErrorCode.InvalidRequest);
    });

    it('should return a redirectable error with state for an unknown display value', async () => {
      const error = await expectAuthorizationError(
        validParams({ display: 'custom_display', state: 'display-state' }),
      );
      expect(error).toMatchObject({ redirectable: true, state: 'display-state' });
    });

    it('should leave display undefined when the parameter is omitted', async () => {
      const result = await validate(validParams());

      expect(result.display).toBeUndefined();
    });
  });

  describe('max_age parameter', () => {
    it('should accept valid max_age', async () => {
      const result = await validate(validParams({ max_age: '3600' }));

      expect(result.maxAge).toEqual(3600);
    });

    it('should accept max_age=0', async () => {
      const result = await validate(validParams({ max_age: '0' }));

      expect(result.maxAge).toEqual(0);
    });

    it('should reject non-numeric max_age', async () => {
      const error = await expectAuthorizationError(validParams({ max_age: 'abc' }));
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.InvalidRequest,
        redirectable: true,
      });
    });

    it('should reject negative max_age', async () => {
      const error = await expectAuthorizationError(validParams({ max_age: '-1' }));
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.InvalidRequest,
        redirectable: true,
      });
    });
  });

  // OIDC Dynamic Client Registration 1.0 §2 / Core 1.0 §3.1.2.1:
  // default_max_age is the OP-side default freshness used when the request
  // omits max_age. The max_age request parameter overrides this default.
  describe('default_max_age fallback (OIDC DCR 1.0 §2)', () => {
    const clientWithDefaultMaxAge: ClientInfo = {
      clientId: 'client123',
      redirectUris: ['https://client.example.org/cb'],
      defaultMaxAge: 600,
    };

    it('should fall back to client defaultMaxAge when max_age is absent', async () => {
      const result = await validate(validParams(), [clientWithDefaultMaxAge]);

      expect(result.maxAge).toBe(600);
    });

    it('should prefer request max_age over client defaultMaxAge', async () => {
      const result = await validate(validParams({ max_age: '120' }), [clientWithDefaultMaxAge]);

      expect(result.maxAge).toBe(120);
    });

    it('should leave maxAge undefined when neither max_age nor defaultMaxAge is present', async () => {
      const result = await validate(validParams());

      expect(result.maxAge).toBeUndefined();
    });

    it('should fall back to defaultMaxAge of 0 when max_age is absent', async () => {
      const result = await validate(
        validParams(),
        [
          {
            clientId: 'client123',
            redirectUris: ['https://client.example.org/cb'],
            defaultMaxAge: 0,
          },
        ],
      );

      expect(result.maxAge).toBe(0);
    });

    // OIDC DCR 1.0 §2: default_max_age is a non-negative integer (seconds).
    // An invalid registered value is a server-side configuration error, not a
    // client request error, so it surfaces as a non-redirectable server_error.
    it('should reject negative defaultMaxAge as a non-redirectable server error', async () => {
      const error = await expectAuthorizationError(
        validParams(),
        [
          {
            clientId: 'client123',
            redirectUris: ['https://client.example.org/cb'],
            defaultMaxAge: -1,
          },
        ],
      );
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.ServerError,
        redirectable: false,
      });
    });

    it('should reject non-integer defaultMaxAge as a non-redirectable server error', async () => {
      const error = await expectAuthorizationError(
        validParams(),
        [
          {
            clientId: 'client123',
            redirectUris: ['https://client.example.org/cb'],
            defaultMaxAge: 1.5,
          },
        ],
      );
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.ServerError,
        redirectable: false,
      });
    });

    it('should prefer request max_age even when defaultMaxAge is invalid', async () => {
      const result = await validate(
        validParams({ max_age: '120' }),
        [
          {
            clientId: 'client123',
            redirectUris: ['https://client.example.org/cb'],
            defaultMaxAge: -1,
          },
        ],
      );

      // The request max_age overrides default_max_age, so the invalid
      // registered value is never consulted (OIDC Core 1.0 §3.1.2.1).
      expect(result.maxAge).toBe(120);
    });
  });

  describe('optional parameters that must not cause errors', () => {
    it('should accept ui_locales', async () => {
      const result = await validate(validParams({ ui_locales: 'ja en' }));

      expect(result.uiLocales).toEqual('ja en');
    });

    it('should accept claims_locales', async () => {
      const result = await validate(validParams({ claims_locales: 'ja en' }));

      expect(result.claimsLocales).toEqual('ja en');
    });

    it('should accept acr_values', async () => {
      const result = await validate(validParams({ acr_values: 'urn:mace:incommon:iap:silver' }));

      expect(result.acrValues).toEqual('urn:mace:incommon:iap:silver');
    });

    it('should accept login_hint', async () => {
      const result = await validate(validParams({ login_hint: 'user@example.com' }));

      expect(result.loginHint).toEqual('user@example.com');
    });

    it('should accept id_token_hint', async () => {
      const result = await validate(
        validParams({ id_token_hint: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.signature' }),
      );

      expect(result.idTokenHint).toEqual('eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.signature');
    });
  });

  describe('audience parameter', () => {
    it('should accept audience as space-separated string', async () => {
      const result = await validate(validParams({ audience: 'https://api.example.com' }));

      expect(result.audience).toEqual(['https://api.example.com']);
    });

    it('should accept multiple audience values', async () => {
      const result = await validate(
        validParams({ audience: 'https://api.example.com https://other.example.com' }),
      );

      expect(result.audience).toEqual(['https://api.example.com', 'https://other.example.com']);
    });

    it('should return undefined audience when not provided', async () => {
      const result = await validate(validParams());

      expect(result.audience).toBeUndefined();
    });
  });

  // OP-Req-NotUnderstood: Unknown parameters MUST be ignored
  describe('unknown parameters', () => {
    it('should ignore unknown parameters', async () => {
      const params = validParams({
        unknown_param: 'some_value',
        another_unknown: 'another_value',
      });

      const result = await validate(params);

      expect(result.responseType).toEqual('code');
      expect(result.clientId).toEqual('client123');
      expect((result as Record<string, unknown>)['unknown_param']).toBeUndefined();
    });
  });

  // OIDC Core 1.0 §6.1 (Passing a Request Object by Value): the OP accepts a signed
  // JWS Request Object whose claims are the Authorization Request parameters. The
  // signature is verified against the client's registered JWKS and the request
  // object claims supersede the OAuth query parameters. request_uri (§6.2) remains
  // unsupported and is rejected with request_uri_not_supported (§6.3).
  describe('Request Object by value (request parameter, OIDC Core 1.0 §6.1)', () => {
    let rsaKeyPair: CryptoKeyPair;
    let otherKeyPair: CryptoKeyPair;
    let jwks: JwkSet;
    let roClient: ClientInfo;
    let resolver: ClientResolver;
    const kid = 'ro-key-1';
    const registeredRedirect = 'https://client.example.org/cb';

    beforeAll(async () => {
      rsaKeyPair = (await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair;
      otherKeyPair = (await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair;
      const publicJwk = await exportPublicJwk(rsaKeyPair.publicKey, kid);
      jwks = { keys: [publicJwk] };
      roClient = {
        clientId: 'ro-client',
        redirectUris: [registeredRedirect],
        jwks,
      };
      resolver = createClientResolver([roClient]);
    });

    // Query parameters always carry the OAuth-syntax-required members
    // (response_type, client_id, scope) plus PKCE (required by default).
    function baseParams(
      overrides?: Partial<AuthorizationRequestParams>,
    ): AuthorizationRequestParams {
      return {
        response_type: 'code',
        client_id: 'ro-client',
        scope: 'openid',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
        ...overrides,
      };
    }

    it('should use request object parameters as the values driving subsequent processing', async () => {
      // OIDC Core 1.0 §6.1: the request object claims ARE the request parameters.
      // Every member below is present ONLY in the request object (not the query),
      // so the validated result proves the request object content is consumed and
      // run through the same validation/normalization as query parameters
      // (prompt -> string[], max_age -> number, etc.).
      const request = await buildSignedRequestObject(
        {
          response_type: 'code',
          client_id: 'ro-client',
          redirect_uri: registeredRedirect,
          scope: 'openid profile',
          state: 'ro-state',
          nonce: 'ro-nonce',
          prompt: 'login consent',
          max_age: 120,
          acr_values: 'urn:mace:incommon:iap:silver',
          login_hint: 'alice@example.org',
        },
        rsaKeyPair.privateKey,
        kid,
      );

      const result = await validate(baseParams({ request }), resolver);

      expect(result).toMatchObject({
        responseType: 'code',
        clientId: 'ro-client',
        redirectUri: registeredRedirect,
        scope: ['openid', 'profile'],
        state: 'ro-state',
        nonce: 'ro-nonce',
        prompt: ['login', 'consent'],
        maxAge: 120,
        acrValues: 'urn:mace:incommon:iap:silver',
        loginHint: 'alice@example.org',
      });
    });

    it('should let a request object parameter supersede the same query parameter', async () => {
      // OIDC Core 1.0 §6.1: when a parameter is present in both the query and the
      // request object, the request object value is used (supersede) — consistently
      // for state, nonce, and the rest. Differing values are NOT an error.
      const request = await buildSignedRequestObject(
        {
          response_type: 'code',
          client_id: 'ro-client',
          redirect_uri: registeredRedirect,
          scope: 'openid',
          state: 'ro-state',
          nonce: 'ro-nonce',
        },
        rsaKeyPair.privateKey,
        kid,
      );

      const result = await validate(
        baseParams({ request, state: 'query-state', nonce: 'query-nonce' }),
        resolver,
      );

      expect(result).toMatchObject({
        state: 'ro-state',
        nonce: 'ro-nonce',
      });
    });

    it('should validate a request object parameter the same as a query parameter (invalid prompt)', async () => {
      // A bogus prompt inside the request object must be rejected exactly as a bogus
      // prompt in the query would be — proving the value flows through validatePrompt.
      const request = await buildSignedRequestObject(
        {
          response_type: 'code',
          client_id: 'ro-client',
          redirect_uri: registeredRedirect,
          scope: 'openid',
          prompt: 'bogus',
        },
        rsaKeyPair.privateKey,
        kid,
      );

      const error = await expectAuthorizationError(baseParams({ request }), resolver);
      expect(error.error).toEqual(AuthorizationErrorCode.InvalidRequest);
    });

    it('should reject a request object scope that omits openid (supersedes the query scope)', async () => {
      // The request object scope supersedes the query scope, so an effective scope
      // without openid is rejected exactly as a query scope without openid would be.
      const request = await buildSignedRequestObject(
        {
          response_type: 'code',
          client_id: 'ro-client',
          redirect_uri: registeredRedirect,
          scope: 'profile email',
        },
        rsaKeyPair.privateKey,
        kid,
      );

      const error = await expectAuthorizationError(baseParams({ request }), resolver);
      expect(error.error).toEqual(AuthorizationErrorCode.InvalidScope);
    });

    it('should prefer a valid redirect_uri from the request object over an invalid top-level redirect_uri', async () => {
      // oidcc-ensure-request-object-with-redirect-uri: a valid redirect_uri inside the
      // request object must take precedence over an invalid top-level redirect_uri.
      const request = await buildSignedRequestObject(
        {
          response_type: 'code',
          client_id: 'ro-client',
          redirect_uri: registeredRedirect,
          scope: 'openid',
        },
        rsaKeyPair.privateKey,
        kid,
      );

      const result = await validate(
        baseParams({ request, redirect_uri: 'https://evil.example.com/cb' }),
        resolver,
      );

      expect(result.redirectUri).toBe(registeredRedirect);
    });

    // OIDC Core 1.0 §6.3: "invalid_request_object: The request parameter contains an
    // invalid Request Object." Parse/verification failures use this code, not the
    // generic invalid_request.
    it('should reject a request object whose signature does not verify with invalid_request_object', async () => {
      // Signed with a different key than the one published under kid.
      const request = await buildSignedRequestObject(
        {
          response_type: 'code',
          client_id: 'ro-client',
          redirect_uri: registeredRedirect,
          scope: 'openid',
        },
        otherKeyPair.privateKey,
        kid,
      );

      const error = await expectAuthorizationError(baseParams({ request }), resolver);
      expect(error.error).toEqual(AuthorizationErrorCode.InvalidRequestObject);
    });

    it('should reject a request object with an unknown kid with invalid_request_object', async () => {
      const request = await buildSignedRequestObject(
        {
          response_type: 'code',
          client_id: 'ro-client',
          redirect_uri: registeredRedirect,
          scope: 'openid',
        },
        rsaKeyPair.privateKey,
        'unknown-kid',
      );

      const error = await expectAuthorizationError(baseParams({ request }), resolver);
      expect(error.error).toEqual(AuthorizationErrorCode.InvalidRequestObject);
    });

    it('should reject a request object with an unsupported signing alg with invalid_request_object', async () => {
      const request = buildRequestObjectWithAlg('HS256', {
        response_type: 'code',
        client_id: 'ro-client',
        redirect_uri: registeredRedirect,
        scope: 'openid',
      });

      const error = await expectAuthorizationError(baseParams({ request }), resolver);
      expect(error.error).toEqual(AuthorizationErrorCode.InvalidRequestObject);
    });

    it('should reject a request object when no client JWKS is registered with invalid_request_object', async () => {
      const noJwksClient: ClientInfo = {
        clientId: 'ro-client-nokeys',
        redirectUris: [registeredRedirect],
      };
      const request = await buildSignedRequestObject(
        {
          response_type: 'code',
          client_id: 'ro-client-nokeys',
          redirect_uri: registeredRedirect,
          scope: 'openid',
        },
        rsaKeyPair.privateKey,
        kid,
      );

      const error = await expectAuthorizationError(
        baseParams({ client_id: 'ro-client-nokeys', request }),
        [noJwksClient],
      );
      expect(error.error).toEqual(AuthorizationErrorCode.InvalidRequestObject);
    });

    it('should throw without a redirect uri when the request object cannot be parsed', async () => {
      // A broken Request Object cannot be trusted, including any redirect_uri it may
      // carry, so the error must stay on the OP (non-redirectable, no state echo).
      const error = await expectAuthorizationError(
        baseParams({ request: 'not-a-jwt', state: 'st-broken' }),
        resolver,
      );
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.InvalidRequestObject,
        redirectable: false,
      });
      expect(error.redirectUri).toBeUndefined();
      expect(error.state).toBeUndefined();
    });

    it('should reject when the request object response_type does not match the query', async () => {
      const request = await buildSignedRequestObject(
        {
          response_type: 'token',
          client_id: 'ro-client',
          redirect_uri: registeredRedirect,
          scope: 'openid',
        },
        rsaKeyPair.privateKey,
        kid,
      );

      const error = await expectAuthorizationError(baseParams({ request }), resolver);
      expect(error.error).toEqual(AuthorizationErrorCode.InvalidRequest);
    });

    it('should accept an unsigned (alg=none) request object when allowUnsigned is enabled', async () => {
      // Basic OP conformance compatibility: some Conformance Suite modules send an
      // unsigned request object. Same validation rules apply to its claims.
      const request = buildUnsignedRequestObject({
        response_type: 'code',
        client_id: 'ro-client',
        redirect_uri: registeredRedirect,
        scope: 'openid',
        state: 'u-state',
        nonce: 'u-nonce',
      });

      const result = await validate(
        baseParams({ request }),
        resolver,
        { requestObject: { allowUnsigned: true } },
      );

      expect(result).toMatchObject({
        redirectUri: registeredRedirect,
        state: 'u-state',
        nonce: 'u-nonce',
      });
    });

    it('should reject an unsigned request object with invalid_request_object when allowUnsigned is false', async () => {
      const request = buildUnsignedRequestObject({
        response_type: 'code',
        client_id: 'ro-client',
        redirect_uri: registeredRedirect,
        scope: 'openid',
      });

      const error = await expectAuthorizationError(baseParams({ request }), resolver);
      expect(error.error).toEqual(AuthorizationErrorCode.InvalidRequestObject);
    });

    it('should reject the request_uri parameter with request_uri_not_supported', async () => {
      const error = await expectAuthorizationError(
        baseParams({
          request_uri: 'https://client.example.org/req.jwt',
          redirect_uri: registeredRedirect,
          state: 'st-2',
        }),
        resolver,
      );
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.RequestUriNotSupported,
        redirectable: true,
        redirectUri: registeredRedirect,
        state: 'st-2',
      });
    });

    // OIDC Core 1.0 §3.1.2.1 / §3.1.2.6: the `registration` parameter is unsupported and
    // must be rejected with registration_not_supported (redirectable, state echoed).
    it('should reject the registration parameter with registration_not_supported', async () => {
      const error = await expectAuthorizationError(
        baseParams({
          registration: '{"client_name":"x"}',
          redirect_uri: registeredRedirect,
          state: 'st-reg',
        }),
        resolver,
      );
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.RegistrationNotSupported,
        redirectable: true,
        redirectUri: registeredRedirect,
        state: 'st-reg',
      });
    });

    it('should process a request without the registration parameter normally', async () => {
      const result = await validate(baseParams({ redirect_uri: registeredRedirect }), resolver);
      expect(result.responseType).toBe('code');
    });

    it('should reject a request object with a broken JWS structure with invalid_request_object', async () => {
      const error = await expectAuthorizationError(baseParams({ request: 'not-a-jwt' }), resolver);
      expect(error.error).toEqual(AuthorizationErrorCode.InvalidRequestObject);
    });

    it('should reject a JWE (5-segment) request object with invalid_request_object', async () => {
      const error = await expectAuthorizationError(baseParams({ request: 'a.b.c.d.e' }), resolver);
      expect(error.error).toEqual(AuthorizationErrorCode.InvalidRequestObject);
    });
  });

  describe('error redirectability', () => {
    it('should return non-redirectable error for invalid client_id', async () => {
      const error = await expectAuthorizationError(validParams({ client_id: 'unknown' }));
      expect(error.redirectable).toBe(false);
      expect(error.redirectUri).toBeUndefined();
    });

    it('should return non-redirectable error for invalid redirect_uri', async () => {
      const error = await expectAuthorizationError(
        validParams({ redirect_uri: 'https://evil.example.com/cb' }),
      );
      expect(error.redirectable).toBe(false);
      expect(error.redirectUri).toBeUndefined();
    });

    it('should return redirectable error for other validation failures', async () => {
      const error = await expectAuthorizationError(validParams({ response_type: undefined }));
      expect(error).toMatchObject({
        redirectable: true,
        redirectUri: 'https://client.example.org/cb',
      });
    });

    it('should include state in redirectable errors when state was provided', async () => {
      const error = await expectAuthorizationError(
        validParams({ response_type: 'token', state: 'my-state-value' }),
      );
      expect(error).toMatchObject({ redirectable: true, state: 'my-state-value' });
    });
  });

  describe('validation order', () => {
    it('should validate client_id before redirect_uri', async () => {
      const params: AuthorizationRequestParams = {
        response_type: 'code',
        client_id: 'unknown',
        redirect_uri: 'https://evil.example.com/cb',
        scope: 'openid',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      };

      const error = await expectAuthorizationError(params);
      expect(error).toMatchObject({
        redirectable: false,
        error: AuthorizationErrorCode.InvalidRequest,
      });
    });

    it('should validate redirect_uri before response_type', async () => {
      const params: AuthorizationRequestParams = {
        client_id: 'client123',
        redirect_uri: 'https://evil.example.com/cb',
        scope: 'openid',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      };

      const error = await expectAuthorizationError(params);
      expect(error.redirectable).toBe(false);
    });
  });

  // OIDC Core 1.0 §5.5: claims request parameter
  describe('claims request parameter', () => {
    it('should parse JSON claims with id_token and userinfo members', async () => {
      const claimsJson = JSON.stringify({
        id_token: { acr: { essential: true, values: ['1', '2'] } },
        userinfo: { email: null },
      });
      const params = validParams({ claims: claimsJson });
      const result = await validate(params);
      expect(result.claims?.id_token?.acr).toEqual({ essential: true, values: ['1', '2'] });
      expect(result.claims?.userinfo?.email).toBeNull();
    });

    it('should ignore unknown top-level members in claims', async () => {
      const claimsJson = JSON.stringify({
        id_token: { acr: null },
        unknown_member: { foo: 'bar' },
      });
      const params = validParams({ claims: claimsJson });
      const result = await validate(params);
      expect(result.claims).toBeDefined();
      expect((result.claims as Record<string, unknown>).unknown_member).toBeUndefined();
      expect(result.claims?.id_token?.acr).toBeNull();
    });

    it('should ignore non-object entries inside claims members', async () => {
      const claimsJson = JSON.stringify({
        id_token: { acr: { essential: true }, bogus: 'not-an-object' },
      });
      const params = validParams({ claims: claimsJson });
      const result = await validate(params);
      expect(result.claims?.id_token?.acr).toEqual({ essential: true });
      expect(result.claims?.id_token?.bogus).toBeUndefined();
    });

    it('should reject claims that is not a JSON object', async () => {
      const params = validParams({ claims: 'not-json' });
      const error = await expectAuthorizationError(params);
      expect(error.error).toBe(AuthorizationErrorCode.InvalidRequest);
    });

    it('should leave claims undefined when parameter is omitted', async () => {
      const params = validParams();
      const result = await validate(params);
      expect(result.claims).toBeUndefined();
    });
  });

  // OWASP API4:2023 Unrestricted Resource Consumption / RFC 9700 §2.5:
  // the authorization endpoint is unauthenticated, so the `claims` payload must
  // be size-capped BEFORE JSON.parse to avoid CPU/memory exhaustion (app-layer DoS).
  describe('claims parameter size limit (untrusted input hardening)', () => {
    it('should reject claims longer than the default maximum length with invalid_request', async () => {
      const oversized = 'a'.repeat(DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH + 1);
      const params = validParams({ claims: oversized });
      const error = await expectAuthorizationError(params);
      expect(error.error).toBe(AuthorizationErrorCode.InvalidRequest);
    });

    it('should return a redirectable error with state when claims exceeds the limit', async () => {
      const oversized = 'a'.repeat(DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH + 1);
      const params = validParams({ claims: oversized, state: 'xyz-state' });
      const error = await expectAuthorizationError(params);
      expect(error).toMatchObject({
        redirectable: true,
        redirectUri: 'https://client.example.org/cb',
        state: 'xyz-state',
      });
    });

    it('should not echo the oversized claims value in the error description', async () => {
      const oversized = 'z'.repeat(DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH + 1);
      const params = validParams({ claims: oversized });
      const error = await expectAuthorizationError(params);
      expect(error.errorDescription).not.toContain('zzzz');
    });

    it('should reject oversized claims by size before attempting JSON.parse', async () => {
      // A small custom limit makes a syntactically valid JSON payload exceed it,
      // proving the size guard fires regardless of JSON validity.
      const validButOversized = JSON.stringify({ id_token: { acr: null } });
      const params = validParams({ claims: validButOversized });
      const error = await expectAuthorizationError(
        params,
        [defaultClient],
        { maxClaimsParameterLength: validButOversized.length - 1 },
      );
      expect(error.error).toBe(AuthorizationErrorCode.InvalidRequest);
    });

    it('should accept claims exactly at the configured limit', async () => {
      const base = '{"id_token":{"acr":{"value":""}}}';
      const limit = 60;
      const padding = 'x'.repeat(limit - base.length);
      const atLimit = `{"id_token":{"acr":{"value":"${padding}"}}}`;
      expect(atLimit.length).toBe(limit);
      const params = validParams({ claims: atLimit });
      const result = await validate(params, [defaultClient], { maxClaimsParameterLength: limit });
      expect(result.claims?.id_token?.acr).toEqual({ value: padding });
    });

    it('should reject claims one character over the configured limit', async () => {
      const base = '{"id_token":{"acr":{"value":""}}}';
      const limit = 60;
      const padding = 'x'.repeat(limit - base.length + 1);
      const overLimit = `{"id_token":{"acr":{"value":"${padding}"}}}`;
      expect(overLimit.length).toBe(limit + 1);
      const params = validParams({ claims: overLimit });
      const error = await expectAuthorizationError(
        params,
        [defaultClient],
        { maxClaimsParameterLength: limit },
      );
      expect(error.error).toBe(AuthorizationErrorCode.InvalidRequest);
    });

    it('should still parse a typical small claims payload within the limit', async () => {
      const claimsJson = JSON.stringify({
        id_token: { acr: { essential: true, values: ['1', '2'] } },
        userinfo: { email: null },
      });
      const params = validParams({ claims: claimsJson });
      const result = await validate(params);
      expect(result.claims?.id_token?.acr).toEqual({ essential: true, values: ['1', '2'] });
      expect(result.claims?.userinfo?.email).toBeNull();
    });

    it('should still reject a JSON array within the limit', async () => {
      const params = validParams({ claims: '[]' });
      const error = await expectAuthorizationError(params);
      expect(error.error).toBe(AuthorizationErrorCode.InvalidRequest);
    });

    it('should still reject JSON null within the limit', async () => {
      const params = validParams({ claims: 'null' });
      const error = await expectAuthorizationError(params);
      expect(error.error).toBe(AuthorizationErrorCode.InvalidRequest);
    });
  });

  // OIDC Core 1.0 §11: offline_access requires prompt=consent (or another granting condition)
  describe('offline_access scope gating (OIDC Core 1.0 §11)', () => {
    it('should drop offline_access from scope when prompt is missing', async () => {
      const params = validParams({ scope: 'openid offline_access' });
      const result = await validate(params, [refreshGrantClient]);
      expect(result.scope).toEqual(['openid']);
    });

    it('should drop offline_access when prompt does not include consent', async () => {
      const params = validParams({ scope: 'openid offline_access', prompt: 'login' });
      const result = await validate(params, [refreshGrantClient]);
      expect(result.scope).toEqual(['openid']);
    });

    it('should retain offline_access when prompt=consent is present', async () => {
      const params = validParams({ scope: 'openid offline_access', prompt: 'consent' });
      const result = await validate(params, [refreshGrantClient]);
      expect(result.scope).toEqual(['openid', 'offline_access']);
    });

    it('should retain offline_access when prompt includes consent among others', async () => {
      const params = validParams({ scope: 'openid offline_access', prompt: 'login consent' });
      const result = await validate(params, [refreshGrantClient]);
      expect(result.scope).toEqual(['openid', 'offline_access']);
    });

    it('should drop offline_access when prompt=none and offline_access is requested', async () => {
      const params = validParams({ scope: 'openid offline_access', prompt: 'none' });
      const result = await validate(params, [refreshGrantClient]);
      expect(result.scope).toEqual(['openid']);
    });

    it('should allow a custom isOfflineAccessGranted callback to override the default', async () => {
      const params = validParams({ scope: 'openid offline_access' });
      const result = await validate(
        params,
        [refreshGrantClient],
        { isOfflineAccessGranted: () => true },
      );
      expect(result.scope).toEqual(['openid', 'offline_access']);
    });

    it('should pass parsed prompt values to the custom callback', async () => {
      let received: string[] | undefined;
      const params = validParams({ scope: 'openid offline_access', prompt: 'login' });
      await validate(
        params,
        [refreshGrantClient],
        {
          isOfflineAccessGranted: (_req, ctx) => {
            received = ctx.promptValues;
            return false;
          },
        },
      );
      expect(received).toEqual(['login']);
    });
  });

  // RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2: grant_types はクライアントが
  // token endpoint で使える grant type の登録。refresh_token を登録していないクライアントに
  // offline_access を付与しても、その Refresh Token は unauthorized_client で拒否されるだけ
  // なので、認可の時点で offline_access を落とす。
  describe('offline_access gating by registered grant_types', () => {
    it('should drop offline_access when the client omits grant_types', async () => {
      const params = validParams({ scope: 'openid offline_access', prompt: 'consent' });
      const result = await validate(params);
      expect(result.scope).toEqual(['openid']);
    });

    it('should drop offline_access when the client registers only authorization_code', async () => {
      const params = validParams({ scope: 'openid offline_access', prompt: 'consent' });
      const result = await validate(
        params,
        [
          {
            clientId: 'client123',
            redirectUris: ['https://client.example.org/cb'],
            grantTypes: ['authorization_code'],
          },
        ],
      );
      expect(result.scope).toEqual(['openid']);
    });

    it('should retain offline_access when the client registers the refresh_token grant type', async () => {
      const params = validParams({ scope: 'openid offline_access', prompt: 'consent' });
      const result = await validate(params, [refreshGrantClient]);
      expect(result.scope).toEqual(['openid', 'offline_access']);
    });

    it('should pass the resolved client to the custom callback', async () => {
      let receivedGrantTypes: string[] | undefined;
      const params = validParams({ scope: 'openid offline_access', prompt: 'consent' });
      await validate(
        params,
        [refreshGrantClient],
        {
          isOfflineAccessGranted: (_req, ctx) => {
            receivedGrantTypes = ctx.client.grantTypes;
            return false;
          },
        },
      );
      expect(receivedGrantTypes).toEqual(['authorization_code', 'refresh_token']);
    });

    it('should let a custom callback grant offline_access to a client without the refresh_token grant type', async () => {
      const params = validParams({ scope: 'openid offline_access', prompt: 'consent' });
      const result = await validate(
        params,
        [defaultClient],
        { isOfflineAccessGranted: () => true },
      );
      expect(result.scope).toEqual(['openid', 'offline_access']);
    });
  });
});

describe('validateAuthorizationRequest - client response_types enforcement', () => {
  // RFC 6749 §4.1.2.1 / OAuth 2.1 §4.1.2.1: unauthorized_client =
  // "The client is not authorized to request an authorization code using this method."
  // OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2: response_types default is ["code"].
  it('should reject response_type=code with unauthorized_client when client responseTypes excludes code', async () => {
    const client: ClientInfo = {
      clientId: 'client123',
      redirectUris: ['https://client.example.org/cb'],
      responseTypes: [], // explicitly registered without "code"
    };
    const error = await expectAuthorizationError(validParams({ state: 'xyz' }), [client]);
    expect(error.error).toBe(AuthorizationErrorCode.UnauthorizedClient);
  });

  it('should return a redirectable error preserving state for unauthorized_client', async () => {
    const client: ClientInfo = {
      clientId: 'client123',
      redirectUris: ['https://client.example.org/cb'],
      responseTypes: [],
    };
    const error = await expectAuthorizationError(validParams({ state: 'state-abc' }), [client]);
    expect(error).toMatchObject({
      redirectable: true,
      redirectUri: 'https://client.example.org/cb',
      state: 'state-abc',
    });
  });

  it('should allow response_type=code when client responseTypes includes code', async () => {
    const client: ClientInfo = {
      clientId: 'client123',
      redirectUris: ['https://client.example.org/cb'],
      responseTypes: ['code'],
    };
    const result = await validate(validParams(), [client]);
    expect(result.responseType).toBe('code');
  });

  it('should allow response_type=code when responseTypes is unspecified (default ["code"])', async () => {
    // Backward compatibility: clients without responseTypes default to ["code"].
    const result = await validate(validParams());
    expect(result.responseType).toBe('code');
  });

  it('should return unsupported_response_type (not unauthorized_client) for a globally unsupported response_type', async () => {
    // Global OP-level rejection MUST be distinguished from per-client authorization.
    const error = await expectAuthorizationError(validParams({ response_type: 'token' }));
    expect(error.error).toBe(AuthorizationErrorCode.UnsupportedResponseType);
  });
});

// RFC 6749 §4.1.2.1 / OIDC Core §3.1.2.6: state is the client's CSRF token and MUST be
// echoed on redirectable errors, but MUST NOT be echoed when no safe redirect target can
// be resolved (the request would otherwise be reflected to an attacker-controlled URI).
// This matrix freezes which branches echo state so reordering the request-resolution
// pipeline (e.g. for Request Object handling) cannot silently leak or drop it.
describe('validateAuthorizationRequest - state echo/non-echo invariant', () => {
  const STATE = 'csrf-state-123';

  describe('redirectable errors MUST echo state', () => {
    it('should echo state on invalid_scope (scope without openid)', async () => {
      const error = await expectAuthorizationError(
        validParams({ scope: 'profile email', state: STATE }),
      );
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.InvalidScope,
        redirectable: true,
        state: STATE,
      });
    });

    it('should echo state on unsupported_response_type', async () => {
      const error = await expectAuthorizationError(
        validParams({ response_type: 'token', state: STATE }),
      );
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.UnsupportedResponseType,
        redirectable: true,
        state: STATE,
      });
    });

    it('should NOT attach state on a redirectable error when the request omits state', async () => {
      const error = await expectAuthorizationError(validParams({ scope: 'profile email' }));
      expect(error.redirectable).toBe(true);
      expect(error.state).toBeUndefined();
    });
  });

  describe('non-redirectable errors MUST NOT echo state', () => {
    it('should not echo state when client_id is missing', async () => {
      const params: AuthorizationRequestParams = {
        response_type: 'code',
        redirect_uri: 'https://client.example.org/cb',
        scope: 'openid',
        state: STATE,
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      } as AuthorizationRequestParams;
      const error = await expectAuthorizationError(params);
      expect(error.redirectable).toBe(false);
      expect(error.state).toBeUndefined();
    });

    it('should not echo state for an unknown client_id', async () => {
      const error = await expectAuthorizationError(
        validParams({ client_id: 'unknown-client', state: STATE }),
      );
      expect(error.redirectable).toBe(false);
      expect(error.state).toBeUndefined();
    });

    it('should not echo state on a clientId mismatch between request and resolver', async () => {
      const buggyResolver: ClientResolver = {
        findClient: async () => ({
          clientId: 'different-client',
          redirectUris: ['https://client.example.org/cb'],
        }),
      };
      const error = await expectAuthorizationError(validParams({ state: STATE }), buggyResolver);
      expect(error.redirectable).toBe(false);
      expect(error.state).toBeUndefined();
    });

    it('should not echo state for an unregistered redirect_uri', async () => {
      const error = await expectAuthorizationError(
        validParams({ redirect_uri: 'https://evil.example.com/cb', state: STATE }),
      );
      expect(error.redirectable).toBe(false);
      expect(error.state).toBeUndefined();
    });

    it('should not echo state when the Request Object fails to parse', async () => {
      const error = await expectAuthorizationError(
        validParams({ request: 'not.a.valid.jws', state: STATE }),
      );
      expect(error).toMatchObject({
        error: AuthorizationErrorCode.InvalidRequestObject,
        redirectable: false,
      });
      expect(error.state).toBeUndefined();
    });
  });
});

describe('validateRegisteredRedirectUris', () => {
  // Helper: capture the thrown AuthorizationError (or undefined if none thrown)
  function captureError(uris: string[]): AuthorizationError | undefined {
    try {
      validateRegisteredRedirectUris(uris);
      return undefined;
    } catch (e) {
      return e as AuthorizationError;
    }
  }

  describe('Fragment rejection', () => {
    // OIDC Core 1.0 Section 3.1.2.1: redirect_uri MUST NOT include a fragment component
    it('should throw server_error when a registered redirect_uri contains a fragment', () => {
      const error = captureError(['https://client.example.org/cb#frag']);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
    });
  });

  describe('Dangerous scheme rejection', () => {
    // OAuth 2.0 Security BCP / RFC 8252 Section 8.5: dangerous schemes are XSS/RCE vectors
    it.each([
      ['javascript:', 'javascript:alert(1)'],
      ['data:', 'data:text/html,<script>alert(1)</script>'],
      ['file:', 'file:///etc/passwd'],
      ['vbscript:', 'vbscript:msgbox(1)'],
      ['blob:', 'blob:https://example.com/uuid'],
    ])('should throw server_error for a %s scheme', (_scheme, uri) => {
      const error = captureError([uri]);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
    });

    it('should reject dangerous schemes case-insensitively', () => {
      // Scheme comparison MUST be ASCII case-insensitive (RFC 3986 Section 3.1)
      const error = captureError(['JAVASCRIPT:alert(1)']);

      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
    });
  });

  describe('Plaintext http:// rejection', () => {
    // OIDC Core 1.0 Section 3.1.2.1 / RFC 8252 Section 8.4: non-loopback plaintext HTTP is not allowed
    it('should throw server_error for a non-loopback http:// redirect_uri', () => {
      const error = captureError(['http://example.com/cb']);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
    });

    it('should accept http://localhost loopback redirect_uri', () => {
      const error = captureError(['http://localhost:3000/cb']);

      expect(error).toBeUndefined();
    });

    it('should accept http://127.0.0.1 loopback redirect_uri', () => {
      const error = captureError(['http://127.0.0.1:3000/cb']);

      expect(error).toBeUndefined();
    });

    it('should accept any IPv4 loopback http:// redirect_uri', () => {
      const error = captureError(['http://127.0.0.2:3000/cb']);

      expect(error).toBeUndefined();
    });

    it('should accept http://[::1] loopback redirect_uri', () => {
      const error = captureError(['http://[::1]:3000/cb']);

      expect(error).toBeUndefined();
    });
  });

  describe('Allowed redirect_uris', () => {
    it('should accept an https redirect_uri', () => {
      const error = captureError(['https://example.com/cb']);

      expect(error).toBeUndefined();
    });

    // RFC 8252 Section 7.1: custom (private-use) URI schemes are permitted for native apps
    it('should accept a custom scheme redirect_uri', () => {
      const error = captureError(['com.example.app:/oauth2redirect']);

      expect(error).toBeUndefined();
    });
  });
});

// OIDC Core 1.0 §6.3: request パラメータ（Request Object by value）を OP が
// サポートしない構成では request_not_supported で拒否する。機能トグルとして
// requestObject.supported: false で無効化できる（既定は true = 現行挙動）。
describe('validateAuthorizationRequest - requestObject.supported option', () => {
  it('should reject the request parameter with request_not_supported when requestObject.supported is false', async () => {
    const error = await expectAuthorizationError(
      validParams({ request: 'header.payload.signature', state: 'st-req-ns' }),
      [defaultClient],
      { requestObject: { supported: false } },
    );
    expect(error.error).toBe(AuthorizationErrorCode.RequestNotSupported);
    // redirect 先はクエリパラメータから解決され、state も echo される（redirectable）。
    expect(error.redirectUri).toBe('https://client.example.org/cb');
    expect(error.state).toBe('st-req-ns');
  });

  it('should reject without parsing when requestObject.supported is false and the request object is malformed', async () => {
    // サポート時なら parse 失敗で invalid_request（非リダイレクト）になる壊れた値。
    // 非サポート時は parse 前に request_not_supported で拒否されなければならない。
    const error = await expectAuthorizationError(
      validParams({ request: 'not-a-jwt', state: 'st-malformed' }),
      [defaultClient],
      { requestObject: { supported: false } },
    );
    expect(error.error).toBe(AuthorizationErrorCode.RequestNotSupported);
    expect(error.state).toBe('st-malformed');
  });

  it('should validate normally when requestObject.supported is false and no request parameter is sent', async () => {
    const resolver = createClientResolver([defaultClient]);

    const result = await validate(
      validParams(),
      resolver,
      {
      requestObject: { supported: false },
    },
    );

    expect(result).toMatchObject({
      responseType: 'code',
      clientId: 'client123',
      redirectUri: 'https://client.example.org/cb',
      scope: ['openid'],
    });
  });
});
