import { describe, it, expect } from 'vitest';
import {
  extractClientCredentials,
  validateClientAuthMethod,
  verifyClientSecret,
} from './client-auth.js';
import { TokenError, TokenErrorCode } from './token-error.js';
import { resolveAuthenticatedTokenClient } from './token-request.js';
import type { TokenClientInfo, TokenClientResolver } from './token-request.js';

const MULTIPLE_METHODS_DESCRIPTION =
  'Multiple client authentication methods provided. Use either Authorization header or request body, not both.';
const METHOD_MISMATCH_DESCRIPTION =
  'Client authentication method does not match the registered token_endpoint_auth_method';

interface RecordingClientResolver extends TokenClientResolver {
  /** The client_id passed to each findClient call, in call order */
  lookups: string[];
}

function createResolver(clients: TokenClientInfo[]): RecordingClientResolver {
  const lookups: string[] = [];
  return {
    lookups,
    findClient: async (clientId: string) => {
      lookups.push(clientId);
      return clients.find((c) => c.clientId === clientId) ?? null;
    },
  };
}

function basicAuth(clientId: string, clientSecret: string): string {
  const credentials = `${clientId}:${clientSecret}`;
  return `Basic ${btoa(credentials)}`;
}

/** Returns the TokenError thrown by a synchronous step, or undefined when it does not throw. */
function captureError(fn: () => unknown): TokenError | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as TokenError;
  }
}

/** Returns the TokenError rejected by an asynchronous step, or undefined when it resolves. */
async function captureAsyncError(
  fn: () => Promise<unknown>,
): Promise<TokenError | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e as TokenError;
  }
}

// No tokenEndpointAuthMethod: the registered method defaults to client_secret_basic.
const validClient: TokenClientInfo = {
  clientId: 'client-123',
  clientSecret: 'secret-xyz',
};

const basicClient: TokenClientInfo = {
  clientId: 'client-123',
  clientSecret: 'secret-xyz',
  tokenEndpointAuthMethod: 'client_secret_basic',
};

// OIDC Core 1.0 §9 / RFC 7591 §2: the client must be registered for client_secret_post
// (the default is client_secret_basic).
const postClient: TokenClientInfo = {
  clientId: 'client-123',
  clientSecret: 'secret-xyz',
  tokenEndpointAuthMethod: 'client_secret_post',
};

const publicClient: TokenClientInfo = {
  clientId: 'public-client',
  tokenEndpointAuthMethod: 'none',
};

describe('extractClientCredentials', () => {
  describe('client_secret_basic', () => {
    it('should decode percent-encoded clientId in Basic auth credentials', () => {
      // RFC 6749 Section 2.3.1: clientId is form-urlencoded before base64
      // encode: 'my@client' → 'my%40client', then base64('my%40client:secret')
      const encoded = btoa(`${encodeURIComponent('my@client')}:${encodeURIComponent('secret')}`);

      const result = extractClientCredentials({
        params: {},
        authorizationHeader: `Basic ${encoded}`,
      });

      expect(result).toEqual({
        clientId: 'my@client',
        clientSecret: 'secret',
        method: 'client_secret_basic',
      });
    });

    it('should decode percent-encoded clientSecret in Basic auth credentials', () => {
      // RFC 6749 Section 2.3.1: clientSecret is form-urlencoded before base64
      // ':' must be percent-encoded in the secret to avoid being treated as separator
      const encoded = btoa(`${encodeURIComponent('client-1')}:${encodeURIComponent('sec:ret')}`);

      const result = extractClientCredentials({
        params: {},
        authorizationHeader: `Basic ${encoded}`,
      });

      expect(result).toEqual({
        clientId: 'client-1',
        clientSecret: 'sec:ret',
        method: 'client_secret_basic',
      });
    });

    it('should decode plus-encoded space in Basic auth credentials', () => {
      // RFC 6749 Section 2.3.1: space is encoded as '+' in application/x-www-form-urlencoded
      const encoded = btoa('my+client:my+secret');

      const result = extractClientCredentials({
        params: {},
        authorizationHeader: `Basic ${encoded}`,
      });

      expect(result).toEqual({
        clientId: 'my client',
        clientSecret: 'my secret',
        method: 'client_secret_basic',
      });
    });

    it('should throw invalid_client when basic auth header is malformed', () => {
      const error = captureError(() =>
        extractClientCredentials({
          params: {},
          authorizationHeader: 'Basic not-base64-credential',
        }),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error?.error).toBe(TokenErrorCode.InvalidClient);
      expect(error?.errorDescription).toBe('Invalid Authorization header format');
    });

    it('should throw invalid_client when basic credentials lack a colon separator', () => {
      const error = captureError(() =>
        extractClientCredentials({
          params: {},
          authorizationHeader: `Basic ${btoa('no-colon-here')}`,
        }),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error?.error).toBe(TokenErrorCode.InvalidClient);
      expect(error?.errorDescription).toBe('Invalid Authorization header format');
    });

    // RFC 7235 Section 2.1: HTTP authentication scheme is case-insensitive.
    it('should accept lowercase basic scheme', () => {
      const credentials = btoa('client-123:secret-xyz');

      const result = extractClientCredentials({
        params: {},
        authorizationHeader: `basic ${credentials}`,
      });

      expect(result).toEqual({
        clientId: 'client-123',
        clientSecret: 'secret-xyz',
        method: 'client_secret_basic',
      });
    });

    it('should accept uppercase BASIC scheme', () => {
      const credentials = btoa('client-123:secret-xyz');

      const result = extractClientCredentials({
        params: {},
        authorizationHeader: `BASIC ${credentials}`,
      });

      expect(result).toEqual({
        clientId: 'client-123',
        clientSecret: 'secret-xyz',
        method: 'client_secret_basic',
      });
    });

    it('should preserve case of base64 credentials when scheme casing varies', () => {
      // Only the scheme name is compared case-insensitively. Case-folding the
      // base64 payload as well would decode to different credentials.
      const credentials = btoa('client-123:secret-xyz');

      const result = extractClientCredentials({
        params: {},
        authorizationHeader: `bAsIc ${credentials}`,
      });

      expect(result).toEqual({
        clientId: 'client-123',
        clientSecret: 'secret-xyz',
        method: 'client_secret_basic',
      });
    });
  });

  // OAuth 2.1 Section 2.3: a client MUST NOT use more than one authentication method
  describe('Multiple authentication methods', () => {
    it('should throw invalid_request when both basic and post credentials are provided', () => {
      const error = captureError(() =>
        extractClientCredentials({
          params: { client_id: 'client-123', client_secret: 'secret-xyz' },
          authorizationHeader: basicAuth('client-123', 'secret-xyz'),
        }),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error?.error).toBe(TokenErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe(MULTIPLE_METHODS_DESCRIPTION);
      expect(error?.statusCode).toBe(400);
      expect(error?.wwwAuthenticate).toBeUndefined();
    });

    // RFC 6749 §3.2.1: many OAuth client libraries always add client_id to the
    // request body even when authenticating via the Authorization header. A bare
    // client_id (no client_secret) is an identifier, not a second authentication
    // method (§2.3), so it MUST NOT be rejected as multiple methods.
    it('should accept a Basic header accompanied by a matching body client_id', () => {
      const result = extractClientCredentials({
        params: { client_id: 'client-123' },
        authorizationHeader: basicAuth('client-123', 'secret-xyz'),
      });

      expect(result).toEqual({
        clientId: 'client-123',
        clientSecret: 'secret-xyz',
        method: 'client_secret_basic',
      });
    });

    it('should throw invalid_request when Basic header client_id and body client_id disagree', () => {
      // A mismatch between the Basic credential subject and the body identifier is
      // a client misconfiguration; reject it rather than silently trusting one side.
      const error = captureError(() =>
        extractClientCredentials({
          params: { client_id: 'other-client' },
          authorizationHeader: basicAuth('client-123', 'secret-xyz'),
        }),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error?.error).toBe(TokenErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe(
        'client_id in request body does not match the Authorization header',
      );
    });

    it('should throw invalid_request when Basic header is accompanied by a body client_secret', () => {
      // OAuth 2.1 §2.3: a body client_secret is the client_secret_post method, so
      // combining it with Basic is genuinely two authentication methods.
      const error = captureError(() =>
        extractClientCredentials({
          params: { client_secret: 'secret-xyz' },
          authorizationHeader: basicAuth('client-123', 'secret-xyz'),
        }),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error?.error).toBe(TokenErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe(MULTIPLE_METHODS_DESCRIPTION);
    });
  });

  // RFC 6749 §4.1.3: even a client that does not authenticate MUST send client_id,
  // so a request that identifies no client is rejected.
  describe('Missing credentials', () => {
    it('should throw invalid_client when credentials are missing', () => {
      const error = captureError(() =>
        extractClientCredentials({ params: {}, authorizationHeader: '' }),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error?.error).toBe(TokenErrorCode.InvalidClient);
      expect(error?.errorDescription).toBe('Client authentication required');
      expect(error?.statusCode).toBe(401);
      expect(error?.wwwAuthenticate).toBe('Basic realm="Client Authentication"');
    });

    it('should ignore non-Basic Authorization header and fall through to invalid_client', () => {
      const error = captureError(() =>
        extractClientCredentials({ params: {}, authorizationHeader: 'Bearer some-token' }),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error?.error).toBe(TokenErrorCode.InvalidClient);
      expect(error?.errorDescription).toBe('Client authentication required');
    });

    it('should reject public client when client_id is missing', () => {
      // A public client identifies itself with client_id alone, so a token request
      // that omits it identifies no client even though it carries the grant.
      const error = captureError(() =>
        extractClientCredentials({
          params: {
            grant_type: 'authorization_code',
            code: 'auth-code',
            code_verifier: 'code-verifier',
          },
          authorizationHeader: '',
        }),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error?.error).toBe(TokenErrorCode.InvalidClient);
      expect(error?.errorDescription).toBe('Client authentication required');
    });
  });
});

// RFC 6749 §5.2: a client that cannot be identified is rejected with invalid_client.
describe('resolveAuthenticatedTokenClient', () => {
  it('should throw invalid_client when client is not found', async () => {
    const resolver = createResolver([validClient]);
    const presented = extractClientCredentials({
      params: { client_id: 'unknown', client_secret: 'whatever' },
      authorizationHeader: '',
    });

    const error = await captureAsyncError(() =>
      resolveAuthenticatedTokenClient(presented.clientId, resolver),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidClient);
    expect(error?.errorDescription).toBe('Client authentication failed');
    expect(resolver.lookups).toEqual(['unknown']);
  });

  it('should throw invalid_client without looking up a client when client_id is empty', async () => {
    const resolver = createResolver([validClient]);

    const error = await captureAsyncError(() =>
      resolveAuthenticatedTokenClient('', resolver),
    );

    expect(error).toBeInstanceOf(TokenError);
    expect(error?.error).toBe(TokenErrorCode.InvalidClient);
    expect(error?.errorDescription).toBe('Client authentication required');
    expect(resolver.lookups).toEqual([]);
  });
});

describe('validateClientAuthMethod', () => {
  // OIDC Core 1.0 §9 / RFC 7591 §2: a client registered for a specific
  // token_endpoint_auth_method MUST NOT authenticate with a different method
  // (prevents authentication-method downgrade). Default is client_secret_basic.
  describe('token_endpoint_auth_method enforcement', () => {
    it('should reject client_secret_post when client registered client_secret_basic', () => {
      const presented = extractClientCredentials({
        params: { client_id: 'client-123', client_secret: 'secret-xyz' },
        authorizationHeader: '',
      });

      const error = captureError(() => validateClientAuthMethod(basicClient, presented));

      expect(error).toBeInstanceOf(TokenError);
      expect(error?.error).toBe(TokenErrorCode.InvalidClient);
      expect(error?.errorDescription).toBe(METHOD_MISMATCH_DESCRIPTION);
    });

    it('should reject client_secret_basic when client registered client_secret_post', () => {
      const presented = extractClientCredentials({
        params: {},
        authorizationHeader: basicAuth('client-123', 'secret-xyz'),
      });

      const error = captureError(() => validateClientAuthMethod(postClient, presented));

      expect(error).toBeInstanceOf(TokenError);
      expect(error?.error).toBe(TokenErrorCode.InvalidClient);
      expect(error?.errorDescription).toBe(METHOD_MISMATCH_DESCRIPTION);
    });

    it('should accept client_secret_basic when client registered client_secret_basic', () => {
      const presented = extractClientCredentials({
        params: {},
        authorizationHeader: basicAuth('client-123', 'secret-xyz'),
      });

      const error = captureError(() => validateClientAuthMethod(basicClient, presented));

      expect(error).toBeUndefined();
    });

    it('should accept client_secret_post when client registered client_secret_post', () => {
      const presented = extractClientCredentials({
        params: { client_id: 'client-123', client_secret: 'secret-xyz' },
        authorizationHeader: '',
      });

      const error = captureError(() => validateClientAuthMethod(postClient, presented));

      expect(error).toBeUndefined();
    });

    it('should enforce client_secret_basic default when tokenEndpointAuthMethod is unspecified', () => {
      // RFC 7591 §2: when unspecified, the default token_endpoint_auth_method is client_secret_basic.
      const presented = extractClientCredentials({
        params: {},
        authorizationHeader: basicAuth('client-123', 'secret-xyz'),
      });

      const error = captureError(() => validateClientAuthMethod(validClient, presented));

      expect(error).toBeUndefined();
    });

    it('should reject client_secret_post when tokenEndpointAuthMethod is unspecified (default basic)', () => {
      // The default is client_secret_basic, so post-based authentication is rejected.
      const presented = extractClientCredentials({
        params: { client_id: 'client-123', client_secret: 'secret-xyz' },
        authorizationHeader: '',
      });

      const error = captureError(() => validateClientAuthMethod(validClient, presented));

      expect(error).toBeInstanceOf(TokenError);
      expect(error?.error).toBe(TokenErrorCode.InvalidClient);
      expect(error?.errorDescription).toBe(METHOD_MISMATCH_DESCRIPTION);
    });
  });

  // RFC 6749 §2.1 / §3.2.1 / OAuth 2.1 §2.4: a public client has no client_secret
  // and registers token_endpoint_auth_method=none. It identifies itself with
  // client_id only and MUST NOT present client credentials.
  describe('public client (token_endpoint_auth_method=none)', () => {
    it('should accept public client with client_id only in request body', () => {
      const presented = extractClientCredentials({
        params: { client_id: 'public-client' },
        authorizationHeader: '',
      });

      const error = captureError(() => validateClientAuthMethod(publicClient, presented));

      expect(error).toBeUndefined();
    });

    it('should reject public client that presents a client_secret in the body (method downgrade)', () => {
      // A public client registered for `none` must not authenticate with a secret.
      const presented = extractClientCredentials({
        params: { client_id: 'public-client', client_secret: 'unexpected' },
        authorizationHeader: '',
      });

      const error = captureError(() => validateClientAuthMethod(publicClient, presented));

      expect(error).toBeInstanceOf(TokenError);
      expect(error?.error).toBe(TokenErrorCode.InvalidClient);
      expect(error?.errorDescription).toBe(METHOD_MISMATCH_DESCRIPTION);
    });

    it('should reject public client that presents Basic credentials', () => {
      const presented = extractClientCredentials({
        params: {},
        authorizationHeader: basicAuth('public-client', 'unexpected'),
      });

      const error = captureError(() => validateClientAuthMethod(publicClient, presented));

      expect(error).toBeInstanceOf(TokenError);
      expect(error?.error).toBe(TokenErrorCode.InvalidClient);
      expect(error?.errorDescription).toBe(METHOD_MISMATCH_DESCRIPTION);
    });

    it('should keep requiring client authentication for confidential clients sending client_id only', () => {
      // Confidential client (default client_secret_basic) cannot skip the secret.
      const presented = extractClientCredentials({
        params: { client_id: 'client-123' },
        authorizationHeader: '',
      });

      const error = captureError(() => validateClientAuthMethod(validClient, presented));

      expect(error).toBeInstanceOf(TokenError);
      expect(error?.error).toBe(TokenErrorCode.InvalidClient);
      expect(error?.errorDescription).toBe('Client authentication required');
    });
  });
});

// OAuth 2.1 §7.4.1 / RFC 6749 §10.10: the presented secret is compared with the
// registered one in constant time.
describe('verifyClientSecret', () => {
  describe('client_secret_basic', () => {
    it('should accept the secret presented via client_secret_basic', async () => {
      const presented = extractClientCredentials({
        params: {},
        authorizationHeader: basicAuth('client-123', 'secret-xyz'),
      });

      await expect(
        verifyClientSecret(validClient, presented.clientSecret),
      ).resolves.toBeUndefined();
    });

    it('should throw invalid_client when secret does not match in basic auth', async () => {
      const presented = extractClientCredentials({
        params: {},
        authorizationHeader: basicAuth('client-123', 'wrong-secret'),
      });

      const error = await captureAsyncError(() =>
        verifyClientSecret(validClient, presented.clientSecret),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error?.error).toBe(TokenErrorCode.InvalidClient);
      expect(error?.errorDescription).toBe('Client authentication failed');
      expect(error?.statusCode).toBe(401);
      expect(error?.wwwAuthenticate).toBe('Basic realm="Client Authentication"');
    });
  });

  describe('client_secret_post', () => {
    it('should accept the secret presented via client_secret_post', async () => {
      const presented = extractClientCredentials({
        params: { client_id: 'client-123', client_secret: 'secret-xyz' },
        authorizationHeader: '',
      });

      await expect(
        verifyClientSecret(postClient, presented.clientSecret),
      ).resolves.toBeUndefined();
    });

    it('should throw invalid_client when post credentials do not match', async () => {
      const presented = extractClientCredentials({
        params: { client_id: 'client-123', client_secret: 'wrong' },
        authorizationHeader: '',
      });

      const error = await captureAsyncError(() =>
        verifyClientSecret(postClient, presented.clientSecret),
      );

      expect(error).toBeInstanceOf(TokenError);
      expect(error?.error).toBe(TokenErrorCode.InvalidClient);
      expect(error?.errorDescription).toBe('Client authentication failed');
    });
  });
});
