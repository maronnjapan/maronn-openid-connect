import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt, verifyRs256Jwt } from '../../test-support/jwt';
import { providerSigningKeys, rs256Key } from '../../test-support/keys';
import {
  authorizationResponseUrl,
  restoreResponseMode,
  type AuthorizationResponseMode,
  type ResponseModeTransaction,
} from './response-mode';

const ISSUER = 'https://op.example.com';
const REDIRECT_URI = 'https://rp.example.com/callback';
/** 2026-01-01T00:00:00Z in Unix seconds. */
const NOW_SECONDS = 1767225600;

/** A transaction as /authorize stores it, for client-1. */
function transaction(responseMode?: string): ResponseModeTransaction {
  return {
    clientId: 'client-1',
    redirectUri: REDIRECT_URI,
    redirectUriExplicit: true,
    responseType: 'code',
    scope: 'openid',
    csrfToken: 'csrf-1',
    createdAt: NOW_SECONDS * 1000,
    expiresAt: NOW_SECONDS * 1000 + 600_000,
    failedAttempts: 0,
    ...(responseMode === undefined ? {} : { responseMode }),
  };
}

describe('restoreResponseMode', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return undefined without loading the keys for a transaction that asked for no response mode', async () => {
    const loadSigningKeys = vi.fn(async () => providerSigningKeys(await rs256Key()));

    const mode = await restoreResponseMode(transaction(), { issuer: ISSUER, loadSigningKeys });

    expect(mode).toBeUndefined();
    expect(loadSigningKeys).not.toHaveBeenCalled();
  });

  // JARM §2.3.1: /consent answers in the query.jwt mode the authorization request asked for.
  it('should restore the query.jwt mode of the jarm feature for the client of the transaction', async () => {
    const signingKey = await rs256Key();
    const loadSigningKeys = vi.fn(async () => providerSigningKeys(signingKey));

    const mode = await restoreResponseMode(transaction('query.jwt'), { issuer: ISSUER, loadSigningKeys });
    const location = new URL((await mode?.redirect(REDIRECT_URI, { code: 'code-1', state: 'state-1' })) ?? '');
    const jwt = location.searchParams.get('response') ?? '';

    expect(mode?.name).toBe('query.jwt');
    expect(loadSigningKeys).toHaveBeenCalledTimes(1);
    expect([...location.searchParams.keys()]).toEqual(['response']);
    expect(decodeJwt(jwt).payload).toEqual({
      code: 'code-1',
      state: 'state-1',
      iss: ISSUER,
      aud: 'client-1',
      exp: NOW_SECONDS + 60,
    });
    expect(await verifyRs256Jwt(jwt, signingKey.publicJwk)).toBe(true);
  });

  it('should throw for a response mode that no enabled feature answers in', async () => {
    const loadSigningKeys = vi.fn(async () => providerSigningKeys(await rs256Key()));

    await expect(restoreResponseMode(transaction('form_post.jwt'), { issuer: ISSUER, loadSigningKeys })).rejects.toThrow(
      'No enabled feature answers in the response mode "form_post.jwt"',
    );
    expect(loadSigningKeys).not.toHaveBeenCalled();
  });
});

describe('authorizationResponseUrl', () => {
  // RFC 9207 §2: the plain query response carries iss beside the parameters.
  it('should put the parameters and iss in the query of the redirect URI', async () => {
    const url = await authorizationResponseUrl(undefined, REDIRECT_URI, { code: 'code-1', state: 'state-1' }, ISSUER);

    expect(url).toBe('https://rp.example.com/callback?code=code-1&state=state-1&iss=https%3A%2F%2Fop.example.com');
  });

  it('should keep the query of the redirect URI and leave out a parameter whose value is undefined', async () => {
    const url = await authorizationResponseUrl(
      undefined,
      `${REDIRECT_URI}?tenant=a`,
      { error: 'access_denied', error_description: 'The user denied the request', state: undefined },
      ISSUER,
    );

    expect(url).toBe(
      'https://rp.example.com/callback?tenant=a&error=access_denied' +
        '&error_description=The+user+denied+the+request&iss=https%3A%2F%2Fop.example.com',
    );
  });

  // RFC 9207 §2: iss is the issuer of this OP, never a value handed in with the parameters.
  it('should set iss to the issuer even when the parameters carry another one', async () => {
    const url = await authorizationResponseUrl(undefined, REDIRECT_URI, { code: 'code-1', iss: 'https://evil.example.com' }, ISSUER);

    expect(new URL(url).searchParams.getAll('iss')).toEqual([ISSUER]);
  });

  it('should leave the redirect URL to the response mode when there is one', async () => {
    const redirect = vi.fn(async () => 'https://rp.example.com/callback?response=jwt-1');
    const responseMode: AuthorizationResponseMode = { name: 'query.jwt', redirect };

    const url = await authorizationResponseUrl(responseMode, REDIRECT_URI, { code: 'code-1', state: 'state-1' }, ISSUER);

    expect(url).toBe('https://rp.example.com/callback?response=jwt-1');
    expect(redirect).toHaveBeenCalledWith(REDIRECT_URI, { code: 'code-1', state: 'state-1' });
  });
});
