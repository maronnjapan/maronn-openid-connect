import { createAuthTransaction } from '@maronn-openid-connect/core';
import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, requestTo } from '../../test-support/context';
import { SESSION_COOKIE_NAME } from '../_oidc-provider/cookies';
import { createDatabase, registerClient } from '../_oidc-provider/db';
import { stores } from '../_oidc-provider/provider';
import { GET } from './route';

// createAuthTransaction() keeps what core does; a test can add members to the
// transaction it makes, as a feature block of the route does.
vi.mock('@maronn-openid-connect/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@maronn-openid-connect/core')>();
  return { ...original, createAuthTransaction: vi.fn(original.createAuthTransaction) };
});

// provider.ts keeps its clients and stores in the key-value store of db/ (in
// memory for the tests, vitest.config.ts) for the whole file, so every test
// signs in with a browser session of its own.

const CLIENT_ID = 'authorize-route-client';
const REDIRECT_URI = 'https://rp.example.com/callback';
const SUBJECT = 'authorize-route-user';
/** RFC 7636 Appendix B: the S256 code_challenge of its example code_verifier. */
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
/** 2026-01-01T00:00:00Z in Unix seconds. */
const NOW = 1767225600;
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;

beforeAll(async () => {
  await registerClient(createDatabase(), { clientId: CLIENT_ID, redirectUris: [REDIRECT_URI] });
  await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Send an authorization request of the client from a browser signed in with the
 * session, for a scope the End-User consented to, and return where the answer
 * redirects to with its parameters.
 */
async function authorizeWithSession(sessionId: string) {
  await stores.browserSessionStore.set(sessionId, { subject: SUBJECT, authTime: NOW - 30 });
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid',
    state: 'state-1',
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
  });
  const response = await GET(new NextRequest(requestTo(`/authorize?${query}`, {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionId}` },
  })));
  const location = new URL(response.headers.get('Location') ?? '');
  return {
    status: response.status,
    target: location.origin + location.pathname,
    params: Object.fromEntries(location.searchParams),
  };
}

describe('GET /authorize', () => {
  // OIDC Core 1.0 §3.1.2.3 / §3.1.2.5: a signed-in End-User who consented gets
  // the code without a screen (SSO).
  describe('Code of a request that needs no screen', () => {
    // OIDC Core 1.0 §3.1.3.1: the code carries the request and the OP session to
    // the token endpoint, and nothing else.
    it('should redirect with the code and store it with the request and the session', async () => {
      const answer = await authorizeWithSession('authorize-route-session-1');

      expect(answer).toEqual({
        status: 302,
        target: REDIRECT_URI,
        params: { code: expect.stringMatching(RANDOM_VALUE), state: 'state-1', iss: TEST_ISSUER },
      });
      expect(await stores.authCodeStore.get(answer.params['code'] ?? '')).toEqual({
        code: answer.params['code'],
        grantId: expect.stringMatching(RANDOM_VALUE),
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        redirectUriExplicit: true,
        scope: ['openid'],
        subject: SUBJECT,
        used: false,
        expiresAt: NOW + 300,
        authTime: NOW - 30,
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: 'S256',
        sessionId: 'authorize-route-session-1',
      });
    });

    // RFC 9449 §10: the code of a request bound to a key with dpop_jkt carries
    // the key of the transaction to the token endpoint. The dpop feature binds
    // the transaction in a block of its own; this test stands in for that block
    // by adding cnf to the transaction core makes, so that only the code
    // issuance of this route is under test.
    it('should carry the confirmation of a transaction bound to a key into the stored code', async () => {
      const cnf = { jkt: 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs' };
      const core = await vi.importActual<typeof import('@maronn-openid-connect/core')>('@maronn-openid-connect/core');
      vi.mocked(createAuthTransaction).mockImplementationOnce((request, csrfToken, options) => ({
        ...core.createAuthTransaction(request, csrfToken, options),
        cnf,
      }));

      const answer = await authorizeWithSession('authorize-route-session-2');

      expect(answer).toMatchObject({ status: 302, target: REDIRECT_URI });
      expect(await stores.authCodeStore.get(answer.params['code'] ?? '')).toMatchObject({ clientId: CLIENT_ID, subject: SUBJECT, cnf });
    });
  });
});
