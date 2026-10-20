import { AuthorizationError, type AuthorizationRequestParams, type ClientInfo } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt, verifyRs256Jwt } from '../../../../test-support/jwt';
import { es256Key, providerSigningKeys, rs256Key } from '../../../../test-support/keys';
import { locationOf } from '../../../../test-support/responses';
import { resolveJarmResponseContext } from './authorize';

const ISSUER = 'https://op.example.com';
const REDIRECT_URI = 'https://rp.example.com/callback';
/** 2026-01-01T00:00:00Z in Unix seconds. */
const NOW_SECONDS = 1767225600;

const client: ClientInfo = { clientId: 'client-1', redirectUris: [REDIRECT_URI] };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_SECONDS * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

function paramsWith(responseMode?: string): AuthorizationRequestParams {
  return {
    client_id: 'client-1',
    response_type: 'code',
    scope: 'openid',
    ...(responseMode === undefined ? {} : { response_mode: responseMode }),
  } as AuthorizationRequestParams;
}

describe('resolveJarmResponseContext', () => {
  describe('JWT Response Modes', () => {
    // JARM §2.3.1: query.jwt puts the response JWT in the query of the redirect URI.
    it('should answer response_mode=query.jwt in the query.jwt mode, signed for the client with the RS256 key', async () => {
      const signingKey = await rs256Key();
      const keys = providerSigningKeys(await es256Key(), signingKey);

      const mode = resolveJarmResponseContext(paramsWith('query.jwt'), client, REDIRECT_URI, 'state-1', ISSUER, keys);
      const location = new URL(locationOf(await mode?.respond(REDIRECT_URI, { code: 'code-1', state: 'state-1' })));
      const jwt = location.searchParams.get('response') ?? '';

      expect(mode?.name).toBe('query.jwt');
      expect(decodeJwt(jwt)).toEqual({
        header: { alg: 'RS256', kid: 'test-rs256-key' },
        payload: { code: 'code-1', state: 'state-1', iss: ISSUER, aud: 'client-1', exp: NOW_SECONDS + 60 },
      });
      expect(await verifyRs256Jwt(jwt, signingKey.publicJwk)).toBe(true);
    });

    // JARM §2.3.4: for response_type=code, jwt is the shorthand of query.jwt.
    it('should answer response_mode=jwt in the query.jwt mode', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const mode = resolveJarmResponseContext(paramsWith('jwt'), client, REDIRECT_URI, undefined, ISSUER, keys);

      expect(mode?.name).toBe('query.jwt');
    });
  });

  describe('Unsupported JWT Response Modes', () => {
    // JARM §2.3.2: fragment.jwt is not implemented. The redirect_uri is verified
    // by now, so the error goes back to the client (as a plain query error).
    it('should reject response_mode=fragment.jwt with a redirectable invalid_request', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const resolving = Promise.resolve().then(() =>
        resolveJarmResponseContext(paramsWith('fragment.jwt'), client, REDIRECT_URI, 'state-1', ISSUER, keys),
      );

      await expect(resolving).rejects.toBeInstanceOf(AuthorizationError);
      await expect(resolving).rejects.toMatchObject({
        error: 'invalid_request',
        errorDescription: 'response_mode fragment.jwt is not supported',
        redirectUri: REDIRECT_URI,
        state: 'state-1',
        redirectable: true,
      });
    });

    // JARM §2.3.3: form_post.jwt is not implemented either.
    it('should reject response_mode=form_post.jwt with the same invalid_request', async () => {
      const keys = providerSigningKeys(await rs256Key());

      expect(() =>
        resolveJarmResponseContext(paramsWith('form_post.jwt'), client, REDIRECT_URI, undefined, ISSUER, keys),
      ).toThrow('response_mode form_post.jwt is not supported');
    });
  });

  describe('Other Response Modes', () => {
    it('should return undefined when the request names no response_mode', async () => {
      const keys = providerSigningKeys(await rs256Key());

      expect(resolveJarmResponseContext(paramsWith(), client, REDIRECT_URI, 'state-1', ISSUER, keys)).toBeUndefined();
    });

    // JARM adds meaning to the .jwt values only; the others stay ignored as before.
    it('should return undefined for response_mode values outside the .jwt family', async () => {
      const keys = providerSigningKeys(await rs256Key());

      const modes = ['query', 'fragment', 'form_post', 'Query.JWT'].map((responseMode) =>
        resolveJarmResponseContext(paramsWith(responseMode), client, REDIRECT_URI, 'state-1', ISSUER, keys),
      );

      expect(modes).toEqual([undefined, undefined, undefined, undefined]);
    });
  });
});
