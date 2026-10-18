import type { IntrospectionResponse } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestTo } from '../../../../test-support/context';
import { decodeJwt, verifyRs256Jwt } from '../../../../test-support/jwt';
import { es256Key, providerSigningKeys, rs256Key } from '../../../../test-support/keys';
import { respondIntrospectionJwt } from './respond';

/** 2026-01-01T00:00:00Z in Unix seconds. */
const NOW_SECONDS = 1767225600;
const JWT_MEDIA_TYPE = 'application/token-introspection+jwt';

/** An active token of rp-1 for the resource server rs-1. */
const ACTIVE: IntrospectionResponse = {
  active: true,
  scope: 'openid profile',
  client_id: 'rp-1',
  sub: 'alice',
  aud: ['rs-1', 'https://op.example.com/userinfo'],
  exp: NOW_SECONDS + 3600,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_SECONDS * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

function introspectionRequest(accept?: string): Request {
  return requestTo('/introspect', {
    method: 'POST',
    headers: accept === undefined ? {} : { Accept: accept },
  });
}

describe('respondIntrospectionJwt', () => {
  // RFC 9701 §4: only a caller that names the JWT media type gets a JWT; the
  // others keep the JSON response of RFC 7662.
  describe('Requests for JSON', () => {
    it('should return undefined for a request without an Accept header', async () => {
      const keys = providerSigningKeys(await rs256Key());

      expect(await respondIntrospectionJwt(introspectionRequest(), ACTIVE, 'rs-1', keys)).toBeUndefined();
    });

    it('should return undefined for Accept application/json and for a wildcard', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const responses = await Promise.all(
        ['application/json', '*/*', 'application/*'].map((accept) =>
          respondIntrospectionJwt(introspectionRequest(accept), ACTIVE, 'rs-1', keys),
        ),
      );

      expect(responses).toEqual([undefined, undefined, undefined]);
    });
  });

  describe('Requests for a JWT', () => {
    // RFC 9701 §5: the compact JWS under its own media type, never cached (RFC 7662 §2.2).
    it('should answer the signed JWT with the token-introspection+jwt media type and no-store headers', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const response = await respondIntrospectionJwt(introspectionRequest(JWT_MEDIA_TYPE), ACTIVE, 'rs-1', keys);

      expect({
        status: response?.status,
        contentType: response?.headers.get('Content-Type'),
        cacheControl: response?.headers.get('Cache-Control'),
        pragma: response?.headers.get('Pragma'),
      }).toEqual({ status: 200, contentType: JWT_MEDIA_TYPE, cacheControl: 'no-store', pragma: 'no-cache' });
    });

    // RFC 9701 §5: typ token-introspection+jwt, iss / aud / iat, and the RFC 7662
    // members inside token_introspection only.
    it('should sign iss, aud of the caller, iat and the introspection response with the RS256 key', async () => {
      const signingKey = await rs256Key();
      const keys = providerSigningKeys(await es256Key(), signingKey);

      const response = await respondIntrospectionJwt(introspectionRequest(JWT_MEDIA_TYPE), ACTIVE, 'rs-1', keys);
      const jwt = (await response?.text()) ?? '';

      expect(decodeJwt(jwt)).toEqual({
        header: { typ: 'token-introspection+jwt', alg: 'RS256', kid: 'test-rs256-key' },
        payload: { iss: 'https://op.example.com', aud: 'rs-1', iat: NOW_SECONDS, token_introspection: ACTIVE },
      });
      expect(await verifyRs256Jwt(jwt, signingKey.publicJwk)).toBe(true);
    });

    // RFC 9701 §4: the media type may come with parameters and among other types.
    it('should answer a JWT when the media type comes with parameters among other types', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const response = await respondIntrospectionJwt(
        introspectionRequest('application/json;q=0.5, Application/Token-Introspection+JWT;q=1'),
        ACTIVE,
        'rs-1',
        keys,
      );

      expect(response?.headers.get('Content-Type')).toBe(JWT_MEDIA_TYPE);
    });

    // RFC 9701 §3 / §5: a caller that is neither the client of the token nor in
    // its aud learns only that the token is not active for it.
    it('should sign { active: false } for a caller that is neither the client nor an audience of the token', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const response = await respondIntrospectionJwt(introspectionRequest(JWT_MEDIA_TYPE), ACTIVE, 'rs-2', keys);

      expect(decodeJwt((await response?.text()) ?? '').payload).toEqual({
        iss: 'https://op.example.com',
        aud: 'rs-2',
        iat: NOW_SECONDS,
        token_introspection: { active: false },
      });
    });

    it('should sign the response of the client the token was issued to', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const response = await respondIntrospectionJwt(introspectionRequest(JWT_MEDIA_TYPE), ACTIVE, 'rp-1', keys);

      expect(decodeJwt((await response?.text()) ?? '').payload).toMatchObject({ aud: 'rp-1', token_introspection: ACTIVE });
    });

    // RFC 9701 §6: RS256 is pinned, so a key set without it is a configuration error.
    it('should throw when no RS256 signing key is registered', async () => {
      const keys = providerSigningKeys(await es256Key());

      await expect(respondIntrospectionJwt(introspectionRequest(JWT_MEDIA_TYPE), ACTIVE, 'rs-1', keys)).rejects.toThrow(
        'No signing key registered for alg "RS256"',
      );
    });
  });
});
