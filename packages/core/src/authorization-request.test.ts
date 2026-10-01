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

      await validateAuthorizationRequest(validParams(), resolver);

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

      const error = await validateAuthorizationRequest(
        validParams(),
        buggyResolver
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      const authError = error as AuthorizationError;
      expect(authError.redirectable).toBe(false);
      expect(authError.error).toEqual(AuthorizationErrorCode.ServerError);
    });
  });

  describe('client_id validation', () => {
    it('should accept valid client_id', async () => {
      const result = await validateAuthorizationRequest(
        validParams(),
        createClientResolver([defaultClient])
      );

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

      const error = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).redirectable).toBe(false);
    });

    it('should reject unknown client_id', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ client_id: 'unknown-client' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).redirectable).toBe(false);
    });

    it('should return non-redirectable error for unknown client_id', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ client_id: 'unknown-client' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      const authError = error as AuthorizationError;
      expect(authError.redirectable).toBe(false);
      expect(authError.redirectUri).toBeUndefined();
    });
  });

  describe('redirect_uri validation', () => {
    it('should accept registered redirect_uri', async () => {
      const result = await validateAuthorizationRequest(
        validParams(),
        createClientResolver([defaultClient])
      );

      expect(result.redirectUri).toEqual('https://client.example.org/cb');
    });

    // OP-redirect_uri-NotReg: Reject unregistered URIs
    it('should reject unregistered redirect_uri', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ redirect_uri: 'https://evil.example.com/cb' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).redirectable).toBe(false);
    });

    it('should return non-redirectable error for unregistered redirect_uri', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ redirect_uri: 'https://evil.example.com/cb' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      const authError = error as AuthorizationError;
      expect(authError.redirectable).toBe(false);
      expect(authError.redirectUri).toBeUndefined();
      expect(authError.error).toEqual(AuthorizationErrorCode.InvalidRequest);
    });

    it('should use single registered redirect_uri when omitted from request', async () => {
      const params = validParams({ redirect_uri: undefined });

      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient])
      );

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

      const error = await validateAuthorizationRequest(
        params,
        createClientResolver([client])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).redirectable).toBe(false);
    });

    // Exact string matching - RFC 3986 Section 6.2.1
    it('should use exact string matching for redirect_uri', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ redirect_uri: 'https://client.example.org/cb/' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
    });

    // OP-redirect_uri-RegFrag: Reject fragments
    it('should reject redirect_uri with fragment', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ redirect_uri: 'https://client.example.org/cb#fragment' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).redirectable).toBe(false);
    });

    // OP-redirect_uri-RegFrag: Reject when REGISTERED redirect_uri contains fragment
    // OIDC Core 1.0 Section 3.1.2.1: redirect_uri MUST NOT include a fragment component
    it('should throw server_error when registered redirect_uri contains fragment', async () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['https://client.example.org/cb#bad-fragment'],
      };

      const error = await validateAuthorizationRequest(
        validParams({ redirect_uri: 'https://client.example.org/cb#bad-fragment' }),
        createClientResolver([client])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      const authError = error as AuthorizationError;
      expect(authError.error).toEqual(AuthorizationErrorCode.ServerError);
      expect(authError.redirectable).toBe(false);
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

      const error = await validateAuthorizationRequest(
        validParams({ redirect_uri: 'https://client.example.org/cb' }),
        createClientResolver([client])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(
        AuthorizationErrorCode.ServerError
      );
    });

    // OP-redirect_uri-Query-OK: Preserve registered query parameters
    it('should accept redirect_uri with matching registered query parameters', async () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['https://client.example.org/cb?mode=auth'],
      };

      const result = await validateAuthorizationRequest(
        validParams({ redirect_uri: 'https://client.example.org/cb?mode=auth' }),
        createClientResolver([client])
      );

      expect(result.redirectUri).toEqual(
        'https://client.example.org/cb?mode=auth'
      );
    });

    // OP-redirect_uri-Query-Mismatch: Reject mismatched query parameters
    it('should reject redirect_uri with mismatched query parameters', async () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['https://client.example.org/cb?mode=auth'],
      };

      const error = await validateAuthorizationRequest(
        validParams({ redirect_uri: 'https://client.example.org/cb?mode=other' }),
        createClientResolver([client])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
    });

    // OP-redirect_uri-Query-Added: Reject added query parameters
    it('should reject redirect_uri with added query parameters', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ redirect_uri: 'https://client.example.org/cb?extra=param' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
    });

    // Loopback exception: allow variable port numbers (public clients only)
    // OAuth 2.1 Section 10.3.3
    it('should allow different port for loopback redirect_uri when client is public', async () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['http://127.0.0.1/callback'],
        clientType: 'public',
      };

      const result = await validateAuthorizationRequest(
        validParams({ redirect_uri: 'http://127.0.0.1:8080/callback' }),
        createClientResolver([client])
      );

      expect(result.redirectUri).toEqual('http://127.0.0.1:8080/callback');
    });

    it('should allow different port for localhost redirect_uri when client is public', async () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['http://localhost/callback'],
        clientType: 'public',
      };

      const result = await validateAuthorizationRequest(
        validParams({ redirect_uri: 'http://localhost:9000/callback' }),
        createClientResolver([client])
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

      const error = await validateAuthorizationRequest(
        validParams({ redirect_uri: 'http://127.0.0.1:8080/callback' }),
        createClientResolver([client])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
    });

    it('should reject different port for loopback redirect_uri when clientType is unspecified (defaults to strict)', async () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['http://127.0.0.1/callback'],
      };

      const error = await validateAuthorizationRequest(
        validParams({ redirect_uri: 'http://127.0.0.1:8080/callback' }),
        createClientResolver([client])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
    });
  });

  describe('response_type validation', () => {
    // OP-Response-code: Request with response_type=code
    it('should accept response_type=code', async () => {
      const result = await validateAuthorizationRequest(
        validParams(),
        createClientResolver([defaultClient])
      );

      expect(result.responseType).toEqual('code');
    });

    // OP-Response-Missing: Reject missing response_type
    it('should reject missing response_type', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ response_type: undefined }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
      expect((error as AuthorizationError).redirectable).toBe(true);
    });

    it('should reject unsupported response_type', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ response_type: 'token' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(
        AuthorizationErrorCode.UnsupportedResponseType
      );
      expect((error as AuthorizationError).redirectable).toBe(true);
    });
  });

  describe('scope validation', () => {
    it('should accept scope containing openid', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ scope: 'openid profile' }),
        createClientResolver([defaultClient])
      );

      expect(result.scope).toContain('openid');
      expect(result.scope).toContain('profile');
    });

    it('should reject missing scope', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ scope: undefined }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
      expect((error as AuthorizationError).redirectable).toBe(true);
    });

    it('should reject scope without openid', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ scope: 'profile email' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidScope);
      expect((error as AuthorizationError).redirectable).toBe(true);
    });

    it('should parse multiple scopes into array', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ scope: 'openid profile email address phone' }),
        createClientResolver([defaultClient])
      );

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
      const result = await validateAuthorizationRequest(
        validParams({ scope: 'openid openid profile' }),
        createClientResolver([defaultClient])
      );

      expect(result.scope).toEqual(['openid', 'profile']);
    });
  });

  // OAuth 2.1 Section 4.1.1, 7.5 - PKCE is REQUIRED
  describe('PKCE validation (OAuth 2.1)', () => {
    it('should accept valid code_challenge with S256 method', async () => {
      const result = await validateAuthorizationRequest(
        validParams({
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: 'S256',
        }),
        createClientResolver([defaultClient])
      );

      expect(result.codeChallenge).toEqual(
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
      );
      expect(result.codeChallengeMethod).toEqual('S256');
    });

    // Security: plain method is rejected to enforce S256
    it('should reject code_challenge_method=plain', async () => {
      const error = await validateAuthorizationRequest(
        validParams({
          code_challenge: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
          code_challenge_method: 'plain',
        }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
      expect((error as AuthorizationError).redirectable).toBe(true);
    });

    it('should reject missing code_challenge_method', async () => {
      const error = await validateAuthorizationRequest(
        validParams({
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: undefined,
        }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
      expect((error as AuthorizationError).redirectable).toBe(true);
    });

    // OAuth 2.1: PKCE is REQUIRED
    it('should reject missing code_challenge', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ code_challenge: undefined }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
      expect((error as AuthorizationError).redirectable).toBe(true);
    });

    it('should accept missing PKCE parameters for explicit confidential clients when compatibility mode is enabled', async () => {
      const client: ClientInfo = {
        ...defaultClient,
        clientType: 'confidential',
      };

      const result = await validateAuthorizationRequest(
        validParams({
          code_challenge: undefined,
          code_challenge_method: undefined,
        }),
        createClientResolver([client]),
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

      const error = await validateAuthorizationRequest(
        validParams({
          code_challenge: undefined,
          code_challenge_method: undefined,
        }),
        createClientResolver([client]),
        { allowNonPkceAuthorizationCodeFlow: true },
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
      expect((error as AuthorizationError).redirectable).toBe(true);
    });

    it('should reject empty code_challenge', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ code_challenge: '' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
      expect((error as AuthorizationError).redirectable).toBe(true);
    });

    it('should reject invalid code_challenge values even when compatibility mode is enabled', async () => {
      const client: ClientInfo = {
        ...defaultClient,
        clientType: 'confidential',
      };

      const error = await validateAuthorizationRequest(
        validParams({
          code_challenge: 'too-short',
          code_challenge_method: 'S256',
        }),
        createClientResolver([client]),
        { allowNonPkceAuthorizationCodeFlow: true },
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
      expect((error as AuthorizationError).redirectable).toBe(true);
    });

    // OAuth 2.1 Section 7.5.2: MUST reject unsupported methods
    it('should reject unsupported code_challenge_method', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ code_challenge_method: 'S512' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
      expect((error as AuthorizationError).redirectable).toBe(true);
    });

    it('should include state in PKCE error when state was provided', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ code_challenge: undefined, state: 'my-state' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      const authError = error as AuthorizationError;
      expect(authError.state).toEqual('my-state');
    });

    // RFC 7636 Section 4.2: S256 code_challenge is BASE64URL(SHA256(...)),
    // fixed at 43 characters using only [A-Za-z0-9\-_].
    describe('code_challenge format validation (S256)', () => {
      it('should accept a 43-character base64url code_challenge', async () => {
        // 43 chars, includes both '-' and '_' base64url symbols
        const result = await validateAuthorizationRequest(
          validParams({
            code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
            code_challenge_method: 'S256',
          }),
          createClientResolver([defaultClient])
        );

        expect(result.codeChallenge).toEqual(
          'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
        );
      });

      it('should reject a code_challenge shorter than 43 characters', async () => {
        const error = await validateAuthorizationRequest(
          validParams({
            // 42 characters
            code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-c',
            code_challenge_method: 'S256',
          }),
          createClientResolver([defaultClient])
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(AuthorizationError);
        expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
        expect((error as AuthorizationError).redirectable).toBe(true);
      });

      it('should reject a code_challenge longer than 43 characters', async () => {
        const error = await validateAuthorizationRequest(
          validParams({
            // 44 characters
            code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cMa',
            code_challenge_method: 'S256',
          }),
          createClientResolver([defaultClient])
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(AuthorizationError);
        expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
        expect((error as AuthorizationError).redirectable).toBe(true);
      });

      it('should reject a code_challenge containing non-base64url symbols', async () => {
        // '+', '/', '=' are standard base64 but invalid for base64url
        const error = await validateAuthorizationRequest(
          validParams({
            code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSst+/=M',
            code_challenge_method: 'S256',
          }),
          createClientResolver([defaultClient])
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(AuthorizationError);
        expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
        expect((error as AuthorizationError).redirectable).toBe(true);
      });

      it('should reject a code_challenge containing punctuation such as ! or ?', async () => {
        const error = await validateAuthorizationRequest(
          validParams({
            code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSst!?cM',
            code_challenge_method: 'S256',
          }),
          createClientResolver([defaultClient])
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(AuthorizationError);
        expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
        expect((error as AuthorizationError).redirectable).toBe(true);
      });

      it('should reject a code_challenge containing whitespace or newline', async () => {
        const error = await validateAuthorizationRequest(
          validParams({
            code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSst \ncM',
            code_challenge_method: 'S256',
          }),
          createClientResolver([defaultClient])
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(AuthorizationError);
        expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
        expect((error as AuthorizationError).redirectable).toBe(true);
      });

      it('should describe the base64url and 43-character requirement in error_description', async () => {
        const error = await validateAuthorizationRequest(
          validParams({
            code_challenge: 'too-short',
            code_challenge_method: 'S256',
          }),
          createClientResolver([defaultClient])
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(AuthorizationError);
        const description = (error as AuthorizationError).errorDescription;
        expect(description).toContain('43');
        expect(description).toContain('base64url');
      });
    });
  });

  describe('state parameter', () => {
    it('should include state when provided', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ state: 'xyz123' }),
        createClientResolver([defaultClient])
      );

      expect(result.state).toEqual('xyz123');
    });

    it('should not require state', async () => {
      const result = await validateAuthorizationRequest(
        validParams(),
        createClientResolver([defaultClient])
      );

      expect(result.state).toBeUndefined();
    });
  });

  describe('nonce parameter', () => {
    // OP-nonce-code: nonce is optional for code flow
    it('should include nonce when provided', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ nonce: 'nonce-abc' }),
        createClientResolver([defaultClient])
      );

      expect(result.nonce).toEqual('nonce-abc');
    });

    // OP-nonce-NoReq-code: nonce is not required for code flow
    it('should not require nonce for code flow', async () => {
      const result = await validateAuthorizationRequest(
        validParams(),
        createClientResolver([defaultClient])
      );

      expect(result.nonce).toBeUndefined();
    });
  });

  describe('prompt parameter', () => {
    it('should accept prompt=none', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ prompt: 'none' }),
        createClientResolver([defaultClient])
      );

      expect(result.prompt).toEqual(['none']);
    });

    it('should accept prompt=login', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ prompt: 'login' }),
        createClientResolver([defaultClient])
      );

      expect(result.prompt).toEqual(['login']);
    });

    it('should accept prompt=consent', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ prompt: 'consent' }),
        createClientResolver([defaultClient])
      );

      expect(result.prompt).toEqual(['consent']);
    });

    it('should accept prompt=select_account', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ prompt: 'select_account' }),
        createClientResolver([defaultClient])
      );

      expect(result.prompt).toEqual(['select_account']);
    });

    it('should accept multiple prompt values', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ prompt: 'login consent' }),
        createClientResolver([defaultClient])
      );

      expect(result.prompt).toEqual(['login', 'consent']);
    });

    // OIDC Core 1.0 Section 3.1.2.1: none MUST NOT be combined with other values
    it('should reject prompt=none combined with other values', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ prompt: 'none login' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
      expect((error as AuthorizationError).redirectable).toBe(true);
    });

    it('should reject invalid prompt value', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ prompt: 'invalid_value' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
      expect((error as AuthorizationError).redirectable).toBe(true);
    });
  });

  describe('display parameter', () => {
    it('should accept display=page', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ display: 'page' }),
        createClientResolver([defaultClient])
      );

      expect(result.display).toEqual('page');
    });

    it('should accept display=popup', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ display: 'popup' }),
        createClientResolver([defaultClient])
      );

      expect(result.display).toEqual('popup');
    });

    it('should accept display=touch', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ display: 'touch' }),
        createClientResolver([defaultClient])
      );

      expect(result.display).toEqual('touch');
    });

    it('should accept display=wap', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ display: 'wap' }),
        createClientResolver([defaultClient])
      );

      expect(result.display).toEqual('wap');
    });

    // OIDC Core 1.0 §3.1.2.1 defines display values as page/popup/touch/wap only.
    // An unrecognized value is a malformed request -> invalid_request (redirectable).
    it('should reject unknown display value with invalid_request', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ display: 'custom_display' }),
        createClientResolver([defaultClient])
      ).catch((e) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toBe(
        AuthorizationErrorCode.InvalidRequest
      );
    });

    it('should return a redirectable error with state for an unknown display value', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ display: 'custom_display', state: 'display-state' }),
        createClientResolver([defaultClient])
      ).catch((e) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).redirectable).toBe(true);
      expect((error as AuthorizationError).state).toBe('display-state');
    });

    it('should leave display undefined when the parameter is omitted', async () => {
      const result = await validateAuthorizationRequest(
        validParams(),
        createClientResolver([defaultClient])
      );

      expect(result.display).toBeUndefined();
    });
  });

  describe('max_age parameter', () => {
    it('should accept valid max_age', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ max_age: '3600' }),
        createClientResolver([defaultClient])
      );

      expect(result.maxAge).toEqual(3600);
    });

    it('should accept max_age=0', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ max_age: '0' }),
        createClientResolver([defaultClient])
      );

      expect(result.maxAge).toEqual(0);
    });

    it('should reject non-numeric max_age', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ max_age: 'abc' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
      expect((error as AuthorizationError).redirectable).toBe(true);
    });

    it('should reject negative max_age', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ max_age: '-1' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.InvalidRequest);
      expect((error as AuthorizationError).redirectable).toBe(true);
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
      const result = await validateAuthorizationRequest(
        validParams(),
        createClientResolver([clientWithDefaultMaxAge])
      );

      expect(result.maxAge).toBe(600);
    });

    it('should prefer request max_age over client defaultMaxAge', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ max_age: '120' }),
        createClientResolver([clientWithDefaultMaxAge])
      );

      expect(result.maxAge).toBe(120);
    });

    it('should leave maxAge undefined when neither max_age nor defaultMaxAge is present', async () => {
      const result = await validateAuthorizationRequest(
        validParams(),
        createClientResolver([defaultClient])
      );

      expect(result.maxAge).toBeUndefined();
    });

    it('should fall back to defaultMaxAge of 0 when max_age is absent', async () => {
      const result = await validateAuthorizationRequest(
        validParams(),
        createClientResolver([
          {
            clientId: 'client123',
            redirectUris: ['https://client.example.org/cb'],
            defaultMaxAge: 0,
          },
        ])
      );

      expect(result.maxAge).toBe(0);
    });

    // OIDC DCR 1.0 §2: default_max_age is a non-negative integer (seconds).
    // An invalid registered value is a server-side configuration error, not a
    // client request error, so it surfaces as a non-redirectable server_error.
    it('should reject negative defaultMaxAge as a non-redirectable server error', async () => {
      const error = await validateAuthorizationRequest(
        validParams(),
        createClientResolver([
          {
            clientId: 'client123',
            redirectUris: ['https://client.example.org/cb'],
            defaultMaxAge: -1,
          },
        ])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.ServerError);
      expect((error as AuthorizationError).redirectable).toBe(false);
    });

    it('should reject non-integer defaultMaxAge as a non-redirectable server error', async () => {
      const error = await validateAuthorizationRequest(
        validParams(),
        createClientResolver([
          {
            clientId: 'client123',
            redirectUris: ['https://client.example.org/cb'],
            defaultMaxAge: 1.5,
          },
        ])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(AuthorizationErrorCode.ServerError);
      expect((error as AuthorizationError).redirectable).toBe(false);
    });

    it('should prefer request max_age even when defaultMaxAge is invalid', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ max_age: '120' }),
        createClientResolver([
          {
            clientId: 'client123',
            redirectUris: ['https://client.example.org/cb'],
            defaultMaxAge: -1,
          },
        ])
      );

      // The request max_age overrides default_max_age, so the invalid
      // registered value is never consulted (OIDC Core 1.0 §3.1.2.1).
      expect(result.maxAge).toBe(120);
    });
  });

  describe('optional parameters that must not cause errors', () => {
    it('should accept ui_locales', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ ui_locales: 'ja en' }),
        createClientResolver([defaultClient])
      );

      expect(result.uiLocales).toEqual('ja en');
    });

    it('should accept claims_locales', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ claims_locales: 'ja en' }),
        createClientResolver([defaultClient])
      );

      expect(result.claimsLocales).toEqual('ja en');
    });

    it('should accept acr_values', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ acr_values: 'urn:mace:incommon:iap:silver' }),
        createClientResolver([defaultClient])
      );

      expect(result.acrValues).toEqual('urn:mace:incommon:iap:silver');
    });

    it('should accept login_hint', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ login_hint: 'user@example.com' }),
        createClientResolver([defaultClient])
      );

      expect(result.loginHint).toEqual('user@example.com');
    });

    it('should accept id_token_hint', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ id_token_hint: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.signature' }),
        createClientResolver([defaultClient])
      );

      expect(result.idTokenHint).toEqual(
        'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.signature'
      );
    });
  });

  describe('audience parameter', () => {
    it('should accept audience as space-separated string', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ audience: 'https://api.example.com' }),
        createClientResolver([defaultClient])
      );

      expect(result.audience).toEqual(['https://api.example.com']);
    });

    it('should accept multiple audience values', async () => {
      const result = await validateAuthorizationRequest(
        validParams({ audience: 'https://api.example.com https://other.example.com' }),
        createClientResolver([defaultClient])
      );

      expect(result.audience).toEqual(['https://api.example.com', 'https://other.example.com']);
    });

    it('should return undefined audience when not provided', async () => {
      const result = await validateAuthorizationRequest(
        validParams(),
        createClientResolver([defaultClient])
      );

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

      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient])
      );

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

      const result = await validateAuthorizationRequest(
        baseParams({ request }),
        resolver,
      );

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

      const result = await validateAuthorizationRequest(
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

      const error = await validateAuthorizationRequest(
        baseParams({ request }),
        resolver,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(
        AuthorizationErrorCode.InvalidRequest,
      );
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

      const error = await validateAuthorizationRequest(
        baseParams({ request }),
        resolver,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(
        AuthorizationErrorCode.InvalidScope,
      );
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

      const result = await validateAuthorizationRequest(
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

      const error = await validateAuthorizationRequest(
        baseParams({ request }),
        resolver,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(
        AuthorizationErrorCode.InvalidRequestObject,
      );
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

      const error = await validateAuthorizationRequest(
        baseParams({ request }),
        resolver,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(
        AuthorizationErrorCode.InvalidRequestObject,
      );
    });

    it('should reject a request object with an unsupported signing alg with invalid_request_object', async () => {
      const request = buildRequestObjectWithAlg('HS256', {
        response_type: 'code',
        client_id: 'ro-client',
        redirect_uri: registeredRedirect,
        scope: 'openid',
      });

      const error = await validateAuthorizationRequest(
        baseParams({ request }),
        resolver,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(
        AuthorizationErrorCode.InvalidRequestObject,
      );
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

      const error = await validateAuthorizationRequest(
        baseParams({ client_id: 'ro-client-nokeys', request }),
        createClientResolver([noJwksClient]),
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(
        AuthorizationErrorCode.InvalidRequestObject,
      );
    });

    it('should throw without a redirect uri when the request object cannot be parsed', async () => {
      // A broken Request Object cannot be trusted, including any redirect_uri it may
      // carry, so the error must stay on the OP (non-redirectable, no state echo).
      const error = await validateAuthorizationRequest(
        baseParams({ request: 'not-a-jwt', state: 'st-broken' }),
        resolver,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      const authError = error as AuthorizationError;
      expect(authError.error).toEqual(
        AuthorizationErrorCode.InvalidRequestObject,
      );
      expect(authError.redirectable).toBe(false);
      expect(authError.redirectUri).toBeUndefined();
      expect(authError.state).toBeUndefined();
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

      const error = await validateAuthorizationRequest(
        baseParams({ request }),
        resolver,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(
        AuthorizationErrorCode.InvalidRequest,
      );
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

      const result = await validateAuthorizationRequest(
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

      const error = await validateAuthorizationRequest(
        baseParams({ request }),
        resolver,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(
        AuthorizationErrorCode.InvalidRequestObject,
      );
    });

    it('should reject the request_uri parameter with request_uri_not_supported', async () => {
      const error = await validateAuthorizationRequest(
        baseParams({
          request_uri: 'https://client.example.org/req.jwt',
          redirect_uri: registeredRedirect,
          state: 'st-2',
        }),
        resolver,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      const authError = error as AuthorizationError;
      expect(authError.error).toEqual(
        AuthorizationErrorCode.RequestUriNotSupported,
      );
      expect(authError.redirectable).toBe(true);
      expect(authError.redirectUri).toEqual(registeredRedirect);
      expect(authError.state).toEqual('st-2');
    });

    // OIDC Core 1.0 §3.1.2.1 / §3.1.2.6: the `registration` parameter is unsupported and
    // must be rejected with registration_not_supported (redirectable, state echoed).
    it('should reject the registration parameter with registration_not_supported', async () => {
      const error = await validateAuthorizationRequest(
        baseParams({
          registration: '{"client_name":"x"}',
          redirect_uri: registeredRedirect,
          state: 'st-reg',
        }),
        resolver,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      const authError = error as AuthorizationError;
      expect(authError.error).toEqual(
        AuthorizationErrorCode.RegistrationNotSupported,
      );
      expect(authError.redirectable).toBe(true);
      expect(authError.redirectUri).toEqual(registeredRedirect);
      expect(authError.state).toEqual('st-reg');
    });

    it('should process a request without the registration parameter normally', async () => {
      const result = await validateAuthorizationRequest(
        baseParams({ redirect_uri: registeredRedirect }),
        resolver,
      );
      expect(result.responseType).toBe('code');
    });

    it('should reject a request object with a broken JWS structure with invalid_request_object', async () => {
      const error = await validateAuthorizationRequest(
        baseParams({ request: 'not-a-jwt' }),
        resolver,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(
        AuthorizationErrorCode.InvalidRequestObject,
      );
    });

    it('should reject a JWE (5-segment) request object with invalid_request_object', async () => {
      const error = await validateAuthorizationRequest(
        baseParams({ request: 'a.b.c.d.e' }),
        resolver,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toEqual(
        AuthorizationErrorCode.InvalidRequestObject,
      );
    });
  });

  describe('error redirectability', () => {
    it('should return non-redirectable error for invalid client_id', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ client_id: 'unknown' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      const authError = error as AuthorizationError;
      expect(authError.redirectable).toBe(false);
      expect(authError.redirectUri).toBeUndefined();
    });

    it('should return non-redirectable error for invalid redirect_uri', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ redirect_uri: 'https://evil.example.com/cb' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      const authError = error as AuthorizationError;
      expect(authError.redirectable).toBe(false);
      expect(authError.redirectUri).toBeUndefined();
    });

    it('should return redirectable error for other validation failures', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ response_type: undefined }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      const authError = error as AuthorizationError;
      expect(authError.redirectable).toBe(true);
      expect(authError.redirectUri).toEqual('https://client.example.org/cb');
    });

    it('should include state in redirectable errors when state was provided', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ response_type: 'token', state: 'my-state-value' }),
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      const authError = error as AuthorizationError;
      expect(authError.redirectable).toBe(true);
      expect(authError.state).toEqual('my-state-value');
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

      const error = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      const authError = error as AuthorizationError;
      expect(authError.redirectable).toBe(false);
      expect(authError.error).toEqual(AuthorizationErrorCode.InvalidRequest);
    });

    it('should validate redirect_uri before response_type', async () => {
      const params: AuthorizationRequestParams = {
        client_id: 'client123',
        redirect_uri: 'https://evil.example.com/cb',
        scope: 'openid',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      };

      const error = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient])
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AuthorizationError);
      const authError = error as AuthorizationError;
      expect(authError.redirectable).toBe(false);
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
      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient]),
      );
      expect(result.claims?.id_token?.acr).toEqual({ essential: true, values: ['1', '2'] });
      expect(result.claims?.userinfo?.email).toBeNull();
    });

    it('should ignore unknown top-level members in claims', async () => {
      const claimsJson = JSON.stringify({
        id_token: { acr: null },
        unknown_member: { foo: 'bar' },
      });
      const params = validParams({ claims: claimsJson });
      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient]),
      );
      expect(result.claims).toBeDefined();
      expect((result.claims as Record<string, unknown>).unknown_member).toBeUndefined();
      expect(result.claims?.id_token?.acr).toBeNull();
    });

    it('should ignore non-object entries inside claims members', async () => {
      const claimsJson = JSON.stringify({
        id_token: { acr: { essential: true }, bogus: 'not-an-object' },
      });
      const params = validParams({ claims: claimsJson });
      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient]),
      );
      expect(result.claims?.id_token?.acr).toEqual({ essential: true });
      expect(result.claims?.id_token?.bogus).toBeUndefined();
    });

    it('should reject claims that is not a JSON object', async () => {
      const params = validParams({ claims: 'not-json' });
      const error = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient]),
      ).catch((e) => e);
      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toBe(AuthorizationErrorCode.InvalidRequest);
    });

    it('should leave claims undefined when parameter is omitted', async () => {
      const params = validParams();
      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient]),
      );
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
      const error = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient]),
      ).catch((e) => e);
      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toBe(AuthorizationErrorCode.InvalidRequest);
    });

    it('should return a redirectable error with state when claims exceeds the limit', async () => {
      const oversized = 'a'.repeat(DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH + 1);
      const params = validParams({ claims: oversized, state: 'xyz-state' });
      const error = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient]),
      ).catch((e) => e);
      expect((error as AuthorizationError).redirectable).toBe(true);
      expect((error as AuthorizationError).redirectUri).toBe('https://client.example.org/cb');
      expect((error as AuthorizationError).state).toBe('xyz-state');
    });

    it('should not echo the oversized claims value in the error description', async () => {
      const oversized = 'z'.repeat(DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH + 1);
      const params = validParams({ claims: oversized });
      const error = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient]),
      ).catch((e) => e);
      expect((error as AuthorizationError).errorDescription).not.toContain('zzzz');
    });

    it('should reject oversized claims by size before attempting JSON.parse', async () => {
      // A small custom limit makes a syntactically valid JSON payload exceed it,
      // proving the size guard fires regardless of JSON validity.
      const validButOversized = JSON.stringify({ id_token: { acr: null } });
      const params = validParams({ claims: validButOversized });
      const error = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient]),
        { maxClaimsParameterLength: validButOversized.length - 1 },
      ).catch((e) => e);
      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toBe(AuthorizationErrorCode.InvalidRequest);
    });

    it('should accept claims exactly at the configured limit', async () => {
      const base = '{"id_token":{"acr":{"value":""}}}';
      const limit = 60;
      const padding = 'x'.repeat(limit - base.length);
      const atLimit = `{"id_token":{"acr":{"value":"${padding}"}}}`;
      expect(atLimit.length).toBe(limit);
      const params = validParams({ claims: atLimit });
      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient]),
        { maxClaimsParameterLength: limit },
      );
      expect(result.claims?.id_token?.acr).toEqual({ value: padding });
    });

    it('should reject claims one character over the configured limit', async () => {
      const base = '{"id_token":{"acr":{"value":""}}}';
      const limit = 60;
      const padding = 'x'.repeat(limit - base.length + 1);
      const overLimit = `{"id_token":{"acr":{"value":"${padding}"}}}`;
      expect(overLimit.length).toBe(limit + 1);
      const params = validParams({ claims: overLimit });
      const error = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient]),
        { maxClaimsParameterLength: limit },
      ).catch((e) => e);
      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toBe(AuthorizationErrorCode.InvalidRequest);
    });

    it('should still parse a typical small claims payload within the limit', async () => {
      const claimsJson = JSON.stringify({
        id_token: { acr: { essential: true, values: ['1', '2'] } },
        userinfo: { email: null },
      });
      const params = validParams({ claims: claimsJson });
      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient]),
      );
      expect(result.claims?.id_token?.acr).toEqual({ essential: true, values: ['1', '2'] });
      expect(result.claims?.userinfo?.email).toBeNull();
    });

    it('should still reject a JSON array within the limit', async () => {
      const params = validParams({ claims: '[]' });
      const error = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient]),
      ).catch((e) => e);
      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toBe(AuthorizationErrorCode.InvalidRequest);
    });

    it('should still reject JSON null within the limit', async () => {
      const params = validParams({ claims: 'null' });
      const error = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient]),
      ).catch((e) => e);
      expect(error).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).error).toBe(AuthorizationErrorCode.InvalidRequest);
    });
  });

  // OIDC Core 1.0 §11: offline_access requires prompt=consent (or another granting condition)
  describe('offline_access scope gating (OIDC Core 1.0 §11)', () => {
    it('should drop offline_access from scope when prompt is missing', async () => {
      const params = validParams({ scope: 'openid offline_access' });
      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([refreshGrantClient]),
      );
      expect(result.scope).toEqual(['openid']);
    });

    it('should drop offline_access when prompt does not include consent', async () => {
      const params = validParams({ scope: 'openid offline_access', prompt: 'login' });
      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([refreshGrantClient]),
      );
      expect(result.scope).toEqual(['openid']);
    });

    it('should retain offline_access when prompt=consent is present', async () => {
      const params = validParams({ scope: 'openid offline_access', prompt: 'consent' });
      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([refreshGrantClient]),
      );
      expect(result.scope).toEqual(['openid', 'offline_access']);
    });

    it('should retain offline_access when prompt includes consent among others', async () => {
      const params = validParams({ scope: 'openid offline_access', prompt: 'login consent' });
      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([refreshGrantClient]),
      );
      expect(result.scope).toEqual(['openid', 'offline_access']);
    });

    it('should drop offline_access when prompt=none and offline_access is requested', async () => {
      const params = validParams({ scope: 'openid offline_access', prompt: 'none' });
      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([refreshGrantClient]),
      );
      expect(result.scope).toEqual(['openid']);
    });

    it('should allow a custom isOfflineAccessGranted callback to override the default', async () => {
      const params = validParams({ scope: 'openid offline_access' });
      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([refreshGrantClient]),
        { isOfflineAccessGranted: () => true },
      );
      expect(result.scope).toEqual(['openid', 'offline_access']);
    });

    it('should pass parsed prompt values to the custom callback', async () => {
      let received: string[] | undefined;
      const params = validParams({ scope: 'openid offline_access', prompt: 'login' });
      await validateAuthorizationRequest(
        params,
        createClientResolver([refreshGrantClient]),
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
      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient]),
      );
      expect(result.scope).toEqual(['openid']);
    });

    it('should drop offline_access when the client registers only authorization_code', async () => {
      const params = validParams({ scope: 'openid offline_access', prompt: 'consent' });
      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([
          {
            clientId: 'client123',
            redirectUris: ['https://client.example.org/cb'],
            grantTypes: ['authorization_code'],
          },
        ]),
      );
      expect(result.scope).toEqual(['openid']);
    });

    it('should retain offline_access when the client registers the refresh_token grant type', async () => {
      const params = validParams({ scope: 'openid offline_access', prompt: 'consent' });
      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([refreshGrantClient]),
      );
      expect(result.scope).toEqual(['openid', 'offline_access']);
    });

    it('should pass the resolved client to the custom callback', async () => {
      let receivedGrantTypes: string[] | undefined;
      const params = validParams({ scope: 'openid offline_access', prompt: 'consent' });
      await validateAuthorizationRequest(
        params,
        createClientResolver([refreshGrantClient]),
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
      const result = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient]),
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
    const error = await validateAuthorizationRequest(
      validParams({ state: 'xyz' }),
      createClientResolver([client]),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthorizationError);
    const authError = error as AuthorizationError;
    expect(authError.error).toBe(AuthorizationErrorCode.UnauthorizedClient);
  });

  it('should return a redirectable error preserving state for unauthorized_client', async () => {
    const client: ClientInfo = {
      clientId: 'client123',
      redirectUris: ['https://client.example.org/cb'],
      responseTypes: [],
    };
    const error = await validateAuthorizationRequest(
      validParams({ state: 'state-abc' }),
      createClientResolver([client]),
    ).catch((e: unknown) => e);

    const authError = error as AuthorizationError;
    expect(authError.redirectable).toBe(true);
    expect(authError.redirectUri).toBe('https://client.example.org/cb');
    expect(authError.state).toBe('state-abc');
  });

  it('should allow response_type=code when client responseTypes includes code', async () => {
    const client: ClientInfo = {
      clientId: 'client123',
      redirectUris: ['https://client.example.org/cb'],
      responseTypes: ['code'],
    };
    const result = await validateAuthorizationRequest(
      validParams(),
      createClientResolver([client]),
    );
    expect(result.responseType).toBe('code');
  });

  it('should allow response_type=code when responseTypes is unspecified (default ["code"])', async () => {
    // Backward compatibility: clients without responseTypes default to ["code"].
    const result = await validateAuthorizationRequest(
      validParams(),
      createClientResolver([defaultClient]),
    );
    expect(result.responseType).toBe('code');
  });

  it('should return unsupported_response_type (not unauthorized_client) for a globally unsupported response_type', async () => {
    // Global OP-level rejection MUST be distinguished from per-client authorization.
    const error = await validateAuthorizationRequest(
      validParams({ response_type: 'token' }),
      createClientResolver([defaultClient]),
    ).catch((e: unknown) => e);

    const authError = error as AuthorizationError;
    expect(authError.error).toBe(AuthorizationErrorCode.UnsupportedResponseType);
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
      const error = await validateAuthorizationRequest(
        validParams({ scope: 'profile email', state: STATE }),
        createClientResolver([defaultClient]),
      ).catch((e: unknown) => e);

      const authError = error as AuthorizationError;
      expect(authError.error).toBe(AuthorizationErrorCode.InvalidScope);
      expect(authError.redirectable).toBe(true);
      expect(authError.state).toBe(STATE);
    });

    it('should echo state on unsupported_response_type', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ response_type: 'token', state: STATE }),
        createClientResolver([defaultClient]),
      ).catch((e: unknown) => e);

      const authError = error as AuthorizationError;
      expect(authError.error).toBe(AuthorizationErrorCode.UnsupportedResponseType);
      expect(authError.redirectable).toBe(true);
      expect(authError.state).toBe(STATE);
    });

    it('should NOT attach state on a redirectable error when the request omits state', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ scope: 'profile email' }),
        createClientResolver([defaultClient]),
      ).catch((e: unknown) => e);

      const authError = error as AuthorizationError;
      expect(authError.redirectable).toBe(true);
      expect(authError.state).toBeUndefined();
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
      const error = await validateAuthorizationRequest(
        params,
        createClientResolver([defaultClient]),
      ).catch((e: unknown) => e);

      const authError = error as AuthorizationError;
      expect(authError.redirectable).toBe(false);
      expect(authError.state).toBeUndefined();
    });

    it('should not echo state for an unknown client_id', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ client_id: 'unknown-client', state: STATE }),
        createClientResolver([defaultClient]),
      ).catch((e: unknown) => e);

      const authError = error as AuthorizationError;
      expect(authError.redirectable).toBe(false);
      expect(authError.state).toBeUndefined();
    });

    it('should not echo state on a clientId mismatch between request and resolver', async () => {
      const buggyResolver: ClientResolver = {
        findClient: async () => ({
          clientId: 'different-client',
          redirectUris: ['https://client.example.org/cb'],
        }),
      };
      const error = await validateAuthorizationRequest(
        validParams({ state: STATE }),
        buggyResolver,
      ).catch((e: unknown) => e);

      const authError = error as AuthorizationError;
      expect(authError.redirectable).toBe(false);
      expect(authError.state).toBeUndefined();
    });

    it('should not echo state for an unregistered redirect_uri', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ redirect_uri: 'https://evil.example.com/cb', state: STATE }),
        createClientResolver([defaultClient]),
      ).catch((e: unknown) => e);

      const authError = error as AuthorizationError;
      expect(authError.redirectable).toBe(false);
      expect(authError.state).toBeUndefined();
    });

    it('should not echo state when the Request Object fails to parse', async () => {
      const error = await validateAuthorizationRequest(
        validParams({ request: 'not.a.valid.jws', state: STATE }),
        createClientResolver([defaultClient]),
      ).catch((e: unknown) => e);

      const authError = error as AuthorizationError;
      expect(authError.error).toBe(AuthorizationErrorCode.InvalidRequestObject);
      expect(authError.redirectable).toBe(false);
      expect(authError.state).toBeUndefined();
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
    it('should throw server_error for a javascript: scheme', () => {
      const error = captureError(['javascript:alert(1)']);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
    });

    it('should throw server_error for a data: scheme', () => {
      const error = captureError(['data:text/html,<script>alert(1)</script>']);

      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
    });

    it('should throw server_error for a file: scheme', () => {
      const error = captureError(['file:///etc/passwd']);

      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
    });

    it('should throw server_error for a vbscript: scheme', () => {
      const error = captureError(['vbscript:msgbox(1)']);

      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
    });

    it('should throw server_error for a blob: scheme', () => {
      const error = captureError(['blob:https://example.com/uuid']);

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
    const resolver = createClientResolver([defaultClient]);

    let error: AuthorizationError | undefined;
    try {
      await validateAuthorizationRequest(
        validParams({ request: 'header.payload.signature', state: 'st-req-ns' }),
        resolver,
        { requestObject: { supported: false } },
      );
    } catch (e) {
      error = e as AuthorizationError;
    }

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.RequestNotSupported);
    // redirect 先はクエリパラメータから解決され、state も echo される（redirectable）。
    expect(error?.redirectUri).toBe('https://client.example.org/cb');
    expect(error?.state).toBe('st-req-ns');
  });

  it('should reject without parsing when requestObject.supported is false and the request object is malformed', async () => {
    const resolver = createClientResolver([defaultClient]);

    // サポート時なら parse 失敗で invalid_request（非リダイレクト）になる壊れた値。
    // 非サポート時は parse 前に request_not_supported で拒否されなければならない。
    let error: AuthorizationError | undefined;
    try {
      await validateAuthorizationRequest(
        validParams({ request: 'not-a-jwt', state: 'st-malformed' }),
        resolver,
        { requestObject: { supported: false } },
      );
    } catch (e) {
      error = e as AuthorizationError;
    }

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.RequestNotSupported);
    expect(error?.state).toBe('st-malformed');
  });

  it('should validate normally when requestObject.supported is false and no request parameter is sent', async () => {
    const resolver = createClientResolver([defaultClient]);

    const result = await validateAuthorizationRequest(validParams(), resolver, {
      requestObject: { supported: false },
    });

    expect(result).toMatchObject({
      responseType: 'code',
      clientId: 'client123',
      redirectUri: 'https://client.example.org/cb',
      scope: ['openid'],
    });
  });
});
