import type { IntrospectionResponse } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, contextOf, requestTo } from '../../../../test-support/context.js';
import { decodeJwt, es256Key, verifyRs256Jwt } from '../../../../test-support/feature-endpoints.js';
import { rs256Key } from '../../../../test-support/keys.js';
import { signIntrospectionResponse } from './sign-response.js';

/** 2026-01-01T00:00:00Z in Unix seconds. */
const NOW = 1767225600;
const JWT_MEDIA_TYPE = 'application/token-introspection+jwt';

const ACTIVE: IntrospectionResponse = {
  active: true,
  scope: 'openid',
  client_id: 'client-1',
  token_type: 'Bearer',
  sub: 'user-1',
  exp: NOW + 600,
  aud: ['resource-server'],
};

async function contextAccepting(accept: string | undefined, signingKeys?: unknown[]) {
  const headers: Record<string, string> = accept === undefined ? {} : { Accept: accept };
  return contextOf(requestTo('/introspect', { method: 'POST', headers }), {
    config: { issuer: TEST_ISSUER },
    signingKeys: signingKeys ?? [await rs256Key()],
  });
}

describe('signIntrospectionResponse', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // RFC 9701 §4: only the explicit media type asks for a JWT; RFC 7662 JSON stays the default.
  describe('Requests Without the JWT Media Type', () => {
    it('should leave a request without an Accept header to the JSON response', async () => {
      expect(await signIntrospectionResponse(await contextAccepting(undefined), ACTIVE, 'client-1')).toBeUndefined();
    });

    it('should leave a request that accepts application/json to the JSON response', async () => {
      const c = await contextAccepting('application/json');

      expect(await signIntrospectionResponse(c, ACTIVE, 'client-1')).toBeUndefined();
    });

    it('should leave a request that accepts any media type to the JSON response', async () => {
      const c = await contextAccepting('*/*');

      expect(await signIntrospectionResponse(c, ACTIVE, 'client-1')).toBeUndefined();
    });
  });

  describe('Signed Responses', () => {
    // RFC 9701 §5: typ token-introspection+jwt, iss / aud / iat, and the RFC 7662
    // members inside token_introspection.
    it('should answer a signed JWT under its media type for the token client', async () => {
      const signingKey = await rs256Key();
      const c = await contextAccepting(JWT_MEDIA_TYPE);

      const response = await signIntrospectionResponse(c, ACTIVE, 'client-1');
      const jwt = (await response?.text()) ?? '';

      expect(response?.status).toBe(200);
      expect(response?.headers.get('Content-Type')).toBe(JWT_MEDIA_TYPE);
      expect(response?.headers.get('Cache-Control')).toBe('no-store');
      expect(decodeJwt(jwt)).toEqual({
        header: { typ: 'token-introspection+jwt', alg: 'RS256', kid: 'test-rs256-key' },
        payload: { iss: TEST_ISSUER, aud: 'client-1', iat: NOW, token_introspection: ACTIVE },
      });
      expect(await verifyRs256Jwt(jwt, signingKey.publicJwk)).toBe(true);
    });

    it('should keep the active response for a caller listed in the token aud', async () => {
      const c = await contextAccepting(`application/json, ${JWT_MEDIA_TYPE};q=0.9`);

      const response = await signIntrospectionResponse(c, ACTIVE, 'resource-server');

      expect(decodeJwt((await response?.text()) ?? '').payload).toEqual({
        iss: TEST_ISSUER,
        aud: 'resource-server',
        iat: NOW,
        token_introspection: ACTIVE,
      });
    });

    // RFC 9701 §5: a token not meant for the caller is reported { active: false }.
    it('should sign { active: false } for a caller that is neither the token client nor in its aud', async () => {
      const c = await contextAccepting(JWT_MEDIA_TYPE);

      const response = await signIntrospectionResponse(c, ACTIVE, 'other-server');

      expect(decodeJwt((await response?.text()) ?? '').payload).toEqual({
        iss: TEST_ISSUER,
        aud: 'other-server',
        iat: NOW,
        token_introspection: { active: false },
      });
    });
  });

  // RFC 9701 §6: RS256, picked by alg from the key set.
  describe('Signing Key', () => {
    it('should sign with the RS256 key when an ES256 key comes first', async () => {
      const signingKey = await rs256Key();
      const c = await contextAccepting(JWT_MEDIA_TYPE, [await es256Key(), signingKey]);

      const jwt = (await (await signIntrospectionResponse(c, ACTIVE, 'client-1'))?.text()) ?? '';

      expect(decodeJwt(jwt).header).toEqual({ typ: 'token-introspection+jwt', alg: 'RS256', kid: 'test-rs256-key' });
      expect(await verifyRs256Jwt(jwt, signingKey.publicJwk)).toBe(true);
    });

    it('should throw when no RS256 key is registered', async () => {
      const c = await contextAccepting(JWT_MEDIA_TYPE, [await es256Key()]);

      await expect(signIntrospectionResponse(c, ACTIVE, 'client-1')).rejects.toThrow(
        'No signing key registered for alg "RS256"',
      );
    });
  });
});
