import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt, verifyRs256Jwt } from '../../test-support/jwt';
import { providerSigningKeys, rs256Key } from '../../test-support/keys';
import { locationOf } from '../../test-support/responses';
import {
  authorizationResponseOf,
  respondToClient,
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
    const location = new URL(locationOf(await mode?.respond(REDIRECT_URI, { code: 'code-1', state: 'state-1' })));
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

  // Form Post Response Mode §2: /consent answers in the form_post mode the authorization request asked for.
  it('should restore the form_post mode without loading the keys', async () => {
    const loadSigningKeys = vi.fn(async () => providerSigningKeys(await rs256Key()));

    const mode = await restoreResponseMode(transaction('form_post'), { issuer: ISSUER, loadSigningKeys });

    expect(mode?.name).toBe('form_post');
    expect(await mode?.respond(REDIRECT_URI, { code: 'code-1', state: 'state-1' })).toEqual({
      method: 'form_post',
      action: REDIRECT_URI,
      fields: { code: 'code-1', state: 'state-1', iss: ISSUER },
    });
    expect(loadSigningKeys).not.toHaveBeenCalled();
  });

  it('should throw for a response mode that no enabled feature answers in', async () => {
    const loadSigningKeys = vi.fn(async () => providerSigningKeys(await rs256Key()));

    await expect(restoreResponseMode(transaction('form_post.jwt'), { issuer: ISSUER, loadSigningKeys })).rejects.toThrow(
      'No enabled feature answers in the response mode "form_post.jwt"',
    );
    expect(loadSigningKeys).not.toHaveBeenCalled();
  });
});

describe('authorizationResponseOf', () => {
  // RFC 9207 §2: the plain query response carries iss beside the parameters.
  it('should redirect with the parameters and iss in the query of the redirect URI', async () => {
    const response = await authorizationResponseOf(undefined, REDIRECT_URI, { code: 'code-1', state: 'state-1' }, ISSUER);

    expect(response).toEqual({
      method: 'redirect',
      location: 'https://rp.example.com/callback?code=code-1&state=state-1&iss=https%3A%2F%2Fop.example.com',
    });
  });

  it('should keep the query of the redirect URI and leave out a parameter whose value is undefined', async () => {
    const response = await authorizationResponseOf(
      undefined,
      `${REDIRECT_URI}?tenant=a`,
      { error: 'access_denied', error_description: 'The user denied the request', state: undefined },
      ISSUER,
    );

    expect(locationOf(response)).toBe(
      'https://rp.example.com/callback?tenant=a&error=access_denied' +
        '&error_description=The+user+denied+the+request&iss=https%3A%2F%2Fop.example.com',
    );
  });

  // RFC 9207 §2: iss is the issuer of this OP, never a value handed in with the parameters.
  it('should set iss to the issuer even when the parameters carry another one', async () => {
    const response = await authorizationResponseOf(undefined, REDIRECT_URI, { code: 'code-1', iss: 'https://evil.example.com' }, ISSUER);

    expect(new URL(locationOf(response)).searchParams.getAll('iss')).toEqual([ISSUER]);
  });

  it('should leave the response to the response mode when there is one', async () => {
    const respond = vi.fn(async () => ({ method: 'redirect' as const, location: 'https://rp.example.com/callback?response=jwt-1' }));
    const responseMode: AuthorizationResponseMode = { name: 'query.jwt', respond };

    const response = await authorizationResponseOf(responseMode, REDIRECT_URI, { code: 'code-1', state: 'state-1' }, ISSUER);

    expect(response).toEqual({ method: 'redirect', location: 'https://rp.example.com/callback?response=jwt-1' });
    expect(respond).toHaveBeenCalledWith(REDIRECT_URI, { code: 'code-1', state: 'state-1' });
  });
});

describe('respondToClient', () => {
  const CLEARED_TRANSACTION_COOKIE = '__Host-oidc_txn=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';

  it('should redirect the browser to the location with the cookies attached', () => {
    const response = respondToClient(
      { method: 'redirect', location: 'https://rp.example.com/callback?code=code-1' },
      [CLEARED_TRANSACTION_COOKIE],
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://rp.example.com/callback?code=code-1');
    expect(response.headers.getSetCookie()).toEqual([CLEARED_TRANSACTION_COOKIE]);
  });

  // OAuth 2.0 Form Post Response Mode §2 / Appendix A: a POST form to the
  // redirect URI with one hidden field per parameter, which the User Agent
  // must not store.
  it('should answer a form_post response with the form page the browser posts', async () => {
    const response = respondToClient(
      {
        method: 'form_post',
        action: 'https://rp.example.com/callback?tenant=a',
        fields: { code: 'code-1', state: 'state-1', iss: ISSUER },
      },
      [CLEARED_TRANSACTION_COOKIE],
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
    expect(response.headers.get('Cache-Control')).toBe('no-cache, no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.getSetCookie()).toEqual([CLEARED_TRANSACTION_COOKIE]);
    expect(await response.text()).toBe(`<!DOCTYPE html>
<html>
<head><title>Submit This Form</title></head>
<body>
  <form method="post" action="https://rp.example.com/callback?tenant=a">
    <input type="hidden" name="code" value="code-1"/>
    <input type="hidden" name="state" value="state-1"/>
    <input type="hidden" name="iss" value="https://op.example.com"/>
    <noscript><button type="submit">Continue</button></noscript>
  </form>
  <script>document.forms[0].submit();</script>
</body>
</html>`);
  });

  // state is chosen by the client and error_description may echo request input.
  it('should escape the action and the field values of the form', async () => {
    const response = respondToClient({
      method: 'form_post',
      action: 'https://rp.example.com/callback?a="b"',
      fields: { state: '"><script>alert(1)</script>' },
    });

    const html = await response.text();
    expect(html).toContain('action="https://rp.example.com/callback?a=&quot;b&quot;"');
    expect(html).toContain('<input type="hidden" name="state" value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"/>');
    expect(html.split('<script>')).toHaveLength(2);
  });
});
