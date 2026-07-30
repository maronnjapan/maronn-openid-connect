import { describe, it, expect } from 'vitest';
import { authenticateClient } from './client-auth';
import { TokenError, TokenErrorCode } from './token-request';
import type { TokenClientInfo, TokenClientResolver } from './token-request';

function createResolver(clients: TokenClientInfo[]): TokenClientResolver {
  return {
    findClient: async (clientId: string) => {
      return clients.find((c) => c.clientId === clientId) ?? null;
    },
  };
}

function basicAuth(clientId: string, clientSecret: string): string {
  const credentials = `${clientId}:${clientSecret}`;
  return `Basic ${btoa(credentials)}`;
}

describe('authenticateClient', () => {
  const validClient: TokenClientInfo = {
    clientId: 'client-123',
    clientSecret: 'secret-xyz',
  };

  describe('client_secret_basic', () => {
    it('should decode percent-encoded clientId in Basic auth credentials', async () => {
      // RFC 6749 Section 2.3.1: clientId is form-urlencoded before base64
      const clientWithAt: TokenClientInfo = { clientId: 'my@client', clientSecret: 'secret' };
      const resolver = createResolver([clientWithAt]);
      // encode: 'my@client' → 'my%40client', then base64('my%40client:secret')
      const encoded = btoa(`${encodeURIComponent('my@client')}:${encodeURIComponent('secret')}`);
      const result = await authenticateClient({
        params: {},
        authorizationHeader: `Basic ${encoded}`,
        clientResolver: resolver,
      });
      expect(result).toBe('my@client');
    });

    it('should decode percent-encoded clientSecret in Basic auth credentials', async () => {
      // RFC 6749 Section 2.3.1: clientSecret is form-urlencoded before base64
      const clientWithSpecialSecret: TokenClientInfo = { clientId: 'client-1', clientSecret: 'sec:ret' };
      const resolver = createResolver([clientWithSpecialSecret]);
      // ':' must be percent-encoded in the secret to avoid being treated as separator
      const encoded = btoa(`${encodeURIComponent('client-1')}:${encodeURIComponent('sec:ret')}`);
      const result = await authenticateClient({
        params: {},
        authorizationHeader: `Basic ${encoded}`,
        clientResolver: resolver,
      });
      expect(result).toBe('client-1');
    });

    it('should decode plus-encoded space in Basic auth credentials', async () => {
      // RFC 6749 Section 2.3.1: space is encoded as '+' in application/x-www-form-urlencoded
      const clientWithSpace: TokenClientInfo = { clientId: 'my client', clientSecret: 'my secret' };
      const resolver = createResolver([clientWithSpace]);
      const encoded = btoa('my+client:my+secret');
      const result = await authenticateClient({
        params: {},
        authorizationHeader: `Basic ${encoded}`,
        clientResolver: resolver,
      });
      expect(result).toBe('my client');
    });

    it('should authenticate client via client_secret_basic', async () => {
      const resolver = createResolver([validClient]);
      const result = await authenticateClient({
        params: {},
        authorizationHeader: basicAuth('client-123', 'secret-xyz'),
        clientResolver: resolver,
      });
      expect(result).toBe('client-123');
    });

    it('should throw invalid_client when secret does not match in basic auth', async () => {
      const resolver = createResolver([validClient]);
      await expect(
        authenticateClient({
          params: {},
          authorizationHeader: basicAuth('client-123', 'wrong-secret'),
          clientResolver: resolver,
        }),
      ).rejects.toThrow(TokenError);
    });

    it('should throw invalid_client when basic auth header is malformed', async () => {
      const resolver = createResolver([validClient]);
      await expect(
        authenticateClient({
          params: {},
          authorizationHeader: 'Basic not-base64-credential',
          clientResolver: resolver,
        }),
      ).rejects.toThrow(TokenError);
    });

    it('should throw invalid_client when basic credentials lack a colon separator', async () => {
      const resolver = createResolver([validClient]);
      const malformed = `Basic ${btoa('no-colon-here')}`;
      await expect(
        authenticateClient({
          params: {},
          authorizationHeader: malformed,
          clientResolver: resolver,
        }),
      ).rejects.toThrow(TokenError);
    });
  });

  describe('client_secret_post', () => {
    // OIDC Core 1.0 §9 / RFC 7591 §2: the client must be registered for client_secret_post
    // (the default is client_secret_basic).
    const postClient: TokenClientInfo = {
      clientId: 'client-123',
      clientSecret: 'secret-xyz',
      tokenEndpointAuthMethod: 'client_secret_post',
    };

    it('should authenticate client via client_secret_post', async () => {
      const resolver = createResolver([postClient]);
      const result = await authenticateClient({
        params: { client_id: 'client-123', client_secret: 'secret-xyz' },
        authorizationHeader: '',
        clientResolver: resolver,
      });
      expect(result).toBe('client-123');
    });

    it('should throw invalid_client when post credentials do not match', async () => {
      const resolver = createResolver([postClient]);
      await expect(
        authenticateClient({
          params: { client_id: 'client-123', client_secret: 'wrong' },
          authorizationHeader: '',
          clientResolver: resolver,
        }),
      ).rejects.toThrow(TokenError);
    });
  });

  describe('Validation errors', () => {
    it('should throw invalid_client when credentials are missing', async () => {
      const resolver = createResolver([validClient]);
      await expect(
        authenticateClient({
          params: {},
          authorizationHeader: '',
          clientResolver: resolver,
        }),
      ).rejects.toThrow(TokenError);

      try {
        await authenticateClient({
          params: {},
          authorizationHeader: '',
          clientResolver: resolver,
        });
      } catch (e) {
        expect(e).toBeInstanceOf(TokenError);
        expect((e as TokenError).error).toBe(TokenErrorCode.InvalidClient);
      }
    });

    it('should throw invalid_client when client is not found', async () => {
      const resolver = createResolver([validClient]);
      try {
        await authenticateClient({
          params: { client_id: 'unknown', client_secret: 'whatever' },
          authorizationHeader: '',
          clientResolver: resolver,
        });
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(TokenError);
        expect((e as TokenError).error).toBe(TokenErrorCode.InvalidClient);
      }
    });

    it('should throw invalid_request when both basic and post credentials are provided', async () => {
      // OAuth 2.1 Section 2.3: a client MUST NOT use more than one authentication method
      const resolver = createResolver([validClient]);
      try {
        await authenticateClient({
          params: { client_id: 'client-123', client_secret: 'secret-xyz' },
          authorizationHeader: basicAuth('client-123', 'secret-xyz'),
          clientResolver: resolver,
        });
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(TokenError);
        expect((e as TokenError).error).toBe(TokenErrorCode.InvalidRequest);
      }
    });

    // RFC 6749 §3.2.1: many OAuth client libraries always add client_id to the
    // request body even when authenticating via the Authorization header. A bare
    // client_id (no client_secret) is an identifier, not a second authentication
    // method (§2.3), so it MUST NOT be rejected as multiple methods.
    it('should authenticate when Basic header is accompanied by a matching body client_id', async () => {
      const resolver = createResolver([validClient]);
      const result = await authenticateClient({
        params: { client_id: 'client-123' },
        authorizationHeader: basicAuth('client-123', 'secret-xyz'),
        clientResolver: resolver,
      });
      expect(result).toBe('client-123');
    });

    it('should throw invalid_request when Basic header client_id and body client_id disagree', async () => {
      // A mismatch between the Basic credential subject and the body identifier is
      // a client misconfiguration; reject it rather than silently trusting one side.
      const resolver = createResolver([validClient]);
      try {
        await authenticateClient({
          params: { client_id: 'other-client' },
          authorizationHeader: basicAuth('client-123', 'secret-xyz'),
          clientResolver: resolver,
        });
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(TokenError);
        expect((e as TokenError).error).toBe(TokenErrorCode.InvalidRequest);
      }
    });

    it('should throw invalid_request when Basic header is accompanied by a body client_secret', async () => {
      // OAuth 2.1 §2.3: a body client_secret is the client_secret_post method, so
      // combining it with Basic is genuinely two authentication methods.
      const resolver = createResolver([validClient]);
      try {
        await authenticateClient({
          params: { client_secret: 'secret-xyz' },
          authorizationHeader: basicAuth('client-123', 'secret-xyz'),
          clientResolver: resolver,
        });
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(TokenError);
        expect((e as TokenError).error).toBe(TokenErrorCode.InvalidRequest);
      }
    });

    // RFC 7235 Section 2.1: HTTP authentication scheme is case-insensitive.
    it('should accept lowercase basic scheme', async () => {
      const resolver = createResolver([validClient]);
      const credentials = btoa('client-123:secret-xyz');
      const result = await authenticateClient({
        params: {},
        authorizationHeader: `basic ${credentials}`,
        clientResolver: resolver,
      });
      expect(result).toBe('client-123');
    });

    it('should accept uppercase BASIC scheme', async () => {
      const resolver = createResolver([validClient]);
      const credentials = btoa('client-123:secret-xyz');
      const result = await authenticateClient({
        params: {},
        authorizationHeader: `BASIC ${credentials}`,
        clientResolver: resolver,
      });
      expect(result).toBe('client-123');
    });

    it('should preserve case of base64 credentials when scheme casing varies', async () => {
      const resolver = createResolver([validClient]);
      const credentials = btoa('client-123:secret-xyz');
      const result = await authenticateClient({
        params: {},
        authorizationHeader: `bAsIc ${credentials}`,
        clientResolver: resolver,
      });
      expect(result).toBe('client-123');
    });

    it('should ignore non-Basic Authorization header and fall through to invalid_client', async () => {
      const resolver = createResolver([validClient]);
      try {
        await authenticateClient({
          params: {},
          authorizationHeader: 'Bearer some-token',
          clientResolver: resolver,
        });
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(TokenError);
        expect((e as TokenError).error).toBe(TokenErrorCode.InvalidClient);
      }
    });
  });

  // OIDC Core 1.0 §9 / RFC 7591 §2: a client registered for a specific
  // token_endpoint_auth_method MUST NOT authenticate with a different method
  // (prevents authentication-method downgrade). Default is client_secret_basic.
  describe('token_endpoint_auth_method enforcement', () => {
    it('should reject client_secret_post when client registered client_secret_basic', async () => {
      const basicClient: TokenClientInfo = {
        clientId: 'client-123',
        clientSecret: 'secret-xyz',
        tokenEndpointAuthMethod: 'client_secret_basic',
      };
      const resolver = createResolver([basicClient]);
      const error = await authenticateClient({
        params: { client_id: 'client-123', client_secret: 'secret-xyz' },
        authorizationHeader: '',
        clientResolver: resolver,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TokenError);
      expect((error as TokenError).error).toBe(TokenErrorCode.InvalidClient);
    });

    it('should reject client_secret_basic when client registered client_secret_post', async () => {
      const postClient: TokenClientInfo = {
        clientId: 'client-123',
        clientSecret: 'secret-xyz',
        tokenEndpointAuthMethod: 'client_secret_post',
      };
      const resolver = createResolver([postClient]);
      const error = await authenticateClient({
        params: {},
        authorizationHeader: basicAuth('client-123', 'secret-xyz'),
        clientResolver: resolver,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TokenError);
      expect((error as TokenError).error).toBe(TokenErrorCode.InvalidClient);
    });

    it('should authenticate via client_secret_basic when client registered client_secret_basic', async () => {
      const basicClient: TokenClientInfo = {
        clientId: 'client-123',
        clientSecret: 'secret-xyz',
        tokenEndpointAuthMethod: 'client_secret_basic',
      };
      const resolver = createResolver([basicClient]);
      const result = await authenticateClient({
        params: {},
        authorizationHeader: basicAuth('client-123', 'secret-xyz'),
        clientResolver: resolver,
      });
      expect(result).toBe('client-123');
    });

    it('should authenticate via client_secret_post when client registered client_secret_post', async () => {
      const postClient: TokenClientInfo = {
        clientId: 'client-123',
        clientSecret: 'secret-xyz',
        tokenEndpointAuthMethod: 'client_secret_post',
      };
      const resolver = createResolver([postClient]);
      const result = await authenticateClient({
        params: { client_id: 'client-123', client_secret: 'secret-xyz' },
        authorizationHeader: '',
        clientResolver: resolver,
      });
      expect(result).toBe('client-123');
    });

    it('should enforce client_secret_basic default when tokenEndpointAuthMethod is unspecified', async () => {
      // RFC 7591 §2: when unspecified, the default token_endpoint_auth_method is client_secret_basic.
      const resolver = createResolver([validClient]);
      const viaBasic = await authenticateClient({
        params: {},
        authorizationHeader: basicAuth('client-123', 'secret-xyz'),
        clientResolver: resolver,
      });
      expect(viaBasic).toBe('client-123');
    });

    it('should reject client_secret_post when tokenEndpointAuthMethod is unspecified (default basic)', async () => {
      // The default is client_secret_basic, so post-based authentication is rejected.
      const resolver = createResolver([validClient]);
      const error = await authenticateClient({
        params: { client_id: 'client-123', client_secret: 'secret-xyz' },
        authorizationHeader: '',
        clientResolver: resolver,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TokenError);
      expect((error as TokenError).error).toBe(TokenErrorCode.InvalidClient);
    });
  });

  // RFC 6749 §2.1 / §3.2.1 / OAuth 2.1 §2.4: a public client has no client_secret
  // and registers token_endpoint_auth_method=none. It identifies itself with
  // client_id only and MUST NOT present client credentials.
  describe('public client (token_endpoint_auth_method=none)', () => {
    const publicClient: TokenClientInfo = {
      clientId: 'public-client',
      tokenEndpointAuthMethod: 'none',
    };

    it('should authenticate public client with client_id only in request body', async () => {
      const resolver = createResolver([publicClient]);
      const result = await authenticateClient({
        params: { client_id: 'public-client' },
        authorizationHeader: '',
        clientResolver: resolver,
      });
      expect(result).toBe('public-client');
    });

    it('should reject public client when client_id is missing', async () => {
      const resolver = createResolver([publicClient]);
      const error = await authenticateClient({
        params: {},
        authorizationHeader: '',
        clientResolver: resolver,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TokenError);
      expect((error as TokenError).error).toBe(TokenErrorCode.InvalidClient);
    });

    it('should reject public client that presents a client_secret in the body (method downgrade)', async () => {
      // A public client registered for `none` must not authenticate with a secret.
      const resolver = createResolver([publicClient]);
      const error = await authenticateClient({
        params: { client_id: 'public-client', client_secret: 'unexpected' },
        authorizationHeader: '',
        clientResolver: resolver,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TokenError);
      expect((error as TokenError).error).toBe(TokenErrorCode.InvalidClient);
    });

    it('should reject public client that presents Basic credentials', async () => {
      const resolver = createResolver([publicClient]);
      const error = await authenticateClient({
        params: {},
        authorizationHeader: basicAuth('public-client', 'unexpected'),
        clientResolver: resolver,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TokenError);
      expect((error as TokenError).error).toBe(TokenErrorCode.InvalidClient);
    });

    it('should keep requiring client authentication for confidential clients sending client_id only', async () => {
      // Confidential client (default client_secret_basic) cannot skip the secret.
      const resolver = createResolver([validClient]);
      const error = await authenticateClient({
        params: { client_id: 'client-123' },
        authorizationHeader: '',
        clientResolver: resolver,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TokenError);
      expect((error as TokenError).error).toBe(TokenErrorCode.InvalidClient);
    });
  });
});
