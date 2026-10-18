import { AuthorizationError, type AuthorizationRequestParams, type ClientInfo } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, contextOf } from '../../../../test-support/context.js';
import { decodeJwt } from '../../../../test-support/feature-endpoints.js';
import { rs256Key } from '../../../../test-support/keys.js';
import { resolveJarmResponseContext } from './resolve-jarm-response-mode.js';

const REDIRECT_URI = 'https://rp.example.com/callback';
/** 2026-01-01T00:00:00Z in Unix seconds. */
const NOW_SECONDS = 1767225600;
const client: ClientInfo = { clientId: 'client-1', redirectUris: [REDIRECT_URI] };

function paramsWith(responseMode?: string): AuthorizationRequestParams {
  return {
    client_id: 'client-1',
    response_type: 'code',
    ...(responseMode === undefined ? {} : { response_mode: responseMode }),
  } as AuthorizationRequestParams;
}

async function contextWithKeys() {
  return contextOf(undefined, { signingKeys: [await rs256Key()] });
}

describe('resolveJarmResponseContext', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_SECONDS * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Plain Responses', () => {
    it('should answer in the plain query response when response_mode is absent', async () => {
      const c = await contextWithKeys();

      expect(resolveJarmResponseContext(c, paramsWith(), client, REDIRECT_URI, 'state-1', TEST_ISSUER)).toBeUndefined();
    });

    // JARM extends only the .jwt values; other response_mode values stay ignored as before.
    it('should answer in the plain query response for response_mode=form_post', async () => {
      const c = await contextWithKeys();

      expect(
        resolveJarmResponseContext(c, paramsWith('form_post'), client, REDIRECT_URI, 'state-1', TEST_ISSUER),
      ).toBeUndefined();
    });
  });

  describe('JWT Responses', () => {
    // JARM §2.3.1.
    it('should answer in query.jwt for response_mode=query.jwt, signed for the client and issuer', async () => {
      const c = await contextWithKeys();

      const mode = resolveJarmResponseContext(c, paramsWith('query.jwt'), client, REDIRECT_URI, 'state-1', TEST_ISSUER);
      const location = new URL((await mode?.redirect(REDIRECT_URI, { code: 'code-1' })) ?? REDIRECT_URI);

      expect(mode?.name).toBe('query.jwt');
      expect(decodeJwt(location.searchParams.get('response') ?? '').payload).toEqual({
        code: 'code-1',
        iss: TEST_ISSUER,
        aud: 'client-1',
        exp: NOW_SECONDS + 60,
      });
    });

    // JARM §2.3.4: for response_type=code, jwt means query.jwt.
    it('should answer in query.jwt for the jwt shorthand', async () => {
      const c = await contextWithKeys();

      const mode = resolveJarmResponseContext(c, paramsWith('jwt'), client, REDIRECT_URI, 'state-1', TEST_ISSUER);

      expect(mode?.name).toBe('query.jwt');
    });

    // JARM §2.3.2 / §2.3.3 are not implemented: the rejection is a redirectable error.
    it('should reject response_mode=fragment.jwt with a redirectable invalid_request', async () => {
      const c = await contextWithKeys();

      const resolving = () =>
        resolveJarmResponseContext(c, paramsWith('fragment.jwt'), client, REDIRECT_URI, 'state-1', TEST_ISSUER);

      expect(resolving).toThrow(AuthorizationError);
      expect(resolving).toThrow(
        expect.objectContaining({
          error: 'invalid_request',
          errorDescription: 'response_mode fragment.jwt is not supported',
          redirectUri: REDIRECT_URI,
          state: 'state-1',
        }),
      );
    });
  });
});
