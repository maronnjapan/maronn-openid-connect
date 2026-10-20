import { AuthorizationError, type AuthorizationRequestParams, type ClientInfo } from '@maronn-openid-connect/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, contextOf } from '../../../../test-support/context.js';
import { locationOf } from '../../../../test-support/authorize.js';
import { decodeJwt } from '../../../../test-support/feature-endpoints.js';
import { rs256Key } from '../../../../test-support/keys.js';
import { resolveJarmResponseContext } from './resolve-jarm-response-mode.js';

const REDIRECT_URI = 'https://rp.example.com/callback';
/** 2026-01-01T00:00:00Z in Unix seconds. */
const NOW_SECONDS = 1767225600;
const client: ClientInfo = { clientId: 'client-1', redirectUris: [REDIRECT_URI] };

function paramsWith(responseMode?: string, responseType = 'code'): AuthorizationRequestParams {
  return {
    client_id: 'client-1',
    response_type: responseType,
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

    // JARM extends only the .jwt values; form_post is left to the Form Post
    // Response Mode (the step after this one in the pipeline).
    it('should answer in no JARM response mode for response_mode=form_post', async () => {
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
      const location = new URL(locationOf(await mode!.respond(REDIRECT_URI, { code: 'code-1' })));

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

  describe('Response Types with Tokens', () => {
    // JARM §2.3.1 forbids query.jwt for a response type that contains token or
    // id_token (unencrypted), and §2.3.4 answers jwt for them with
    // fragment.jwt: the Implicit Flow refuses those modes in the fragment.
    it('should leave every JWT response mode of id_token and id_token token to the feature of the response type', async () => {
      const c = await contextWithKeys();

      const modes = [
        ['query.jwt', 'id_token'],
        ['jwt', 'id_token token'],
        ['fragment.jwt', 'token id_token'],
        ['jwt', 'token'],
      ].map(([responseMode, responseType]) =>
        resolveJarmResponseContext(c, paramsWith(responseMode, responseType), client, REDIRECT_URI, 'state-1', TEST_ISSUER),
      );

      expect(modes).toEqual([undefined, undefined, undefined, undefined]);
    });
  });
});
