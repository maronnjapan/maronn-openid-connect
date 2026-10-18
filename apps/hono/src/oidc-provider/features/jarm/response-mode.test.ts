import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, contextOf } from '../../../test-support/context.js';
import { decodeJwt, es256Key, verifyRs256Jwt } from '../../../test-support/feature-endpoints.js';
import { rs256Key } from '../../../test-support/keys.js';
import { jarmResponseMode, jarmResponseModeHandler, selectJarmSigningKey } from './response-mode.js';

const REDIRECT_URI = 'https://rp.example.com/callback';
/** 2026-01-01T00:00:00Z in Unix seconds. */
const NOW_SECONDS = 1767225600;

function freezeTime() {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_SECONDS * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

/** The response JWT of a redirect URL (JARM §2.3.1). */
function responseOf(location: string): string {
  return new URL(location).searchParams.get('response') ?? '';
}

describe('jarmResponseMode', () => {
  freezeTime();

  it('should be named query.jwt', async () => {
    const mode = jarmResponseMode({ issuer: TEST_ISSUER, clientId: 'client-1', signingKey: await rs256Key() });

    expect(mode.name).toBe('query.jwt');
  });

  // JARM §2.3.1: the only parameter added to the redirect URI is response.
  it('should add the response parameter as the only parameter of the redirect URI', async () => {
    const mode = jarmResponseMode({ issuer: TEST_ISSUER, clientId: 'client-1', signingKey: await rs256Key() });

    const location = new URL(await mode.redirect(`${REDIRECT_URI}?tenant=a`, { code: 'code-1', state: 'state-1' }));

    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect([...location.searchParams.keys()]).toEqual(['tenant', 'response']);
  });

  // JARM §2.1 / §3: iss, aud and exp (60 seconds, jarmConfig) beside the
  // response parameters, signed with RS256.
  it('should sign the parameters with iss, aud and exp into an RS256 JWT', async () => {
    const signingKey = await rs256Key();
    const mode = jarmResponseMode({ issuer: TEST_ISSUER, clientId: 'client-1', signingKey });

    const jwt = responseOf(await mode.redirect(REDIRECT_URI, { code: 'code-1', state: 'state-1' }));

    expect(decodeJwt(jwt)).toEqual({
      header: { alg: 'RS256', kid: 'test-rs256-key' },
      payload: { code: 'code-1', state: 'state-1', iss: TEST_ISSUER, aud: 'client-1', exp: NOW_SECONDS + 60 },
    });
    expect(await verifyRs256Jwt(jwt, signingKey.publicJwk)).toBe(true);
  });

  // JARM §2.1: a request without state gets a response JWT without the state claim.
  it('should leave out a parameter whose value is undefined', async () => {
    const mode = jarmResponseMode({ issuer: TEST_ISSUER, clientId: 'client-1', signingKey: await rs256Key() });

    const jwt = responseOf(await mode.redirect(REDIRECT_URI, { error: 'access_denied', state: undefined }));

    expect(decodeJwt(jwt).payload).toEqual({
      error: 'access_denied',
      iss: TEST_ISSUER,
      aud: 'client-1',
      exp: NOW_SECONDS + 60,
    });
  });
});

describe('selectJarmSigningKey', () => {
  // JARM §3: the response JWT is RS256, whichever key comes first in the set.
  it('should pick the RS256 key when an ES256 key comes first', async () => {
    const rs256 = await rs256Key();
    const c = contextOf(undefined, { signingKeys: [await es256Key(), rs256] });

    expect(selectJarmSigningKey(c)).toBe(rs256);
  });

  it('should throw when no RS256 key is registered', async () => {
    const c = contextOf(undefined, { signingKeys: [await es256Key()] });

    expect(() => selectJarmSigningKey(c)).toThrow('No signing key registered for alg "RS256"');
  });

  it('should throw when the context has no signing keys', () => {
    expect(() => selectJarmSigningKey(contextOf())).toThrow('No signing keys available');
  });
});

describe('jarmResponseModeHandler', () => {
  freezeTime();

  it('should restore the response mode named query.jwt', () => {
    expect(jarmResponseModeHandler.names).toEqual(['query.jwt']);
  });

  // JARM §2.3: /consent answers in the mode the stored transaction asked for.
  it('should restore a mode that signs for the stored client and issuer', async () => {
    const signingKey = await rs256Key();
    const c = contextOf(undefined, { signingKeys: [signingKey] });

    const mode = jarmResponseModeHandler.restore(c, {
      name: 'query.jwt',
      clientId: 'stored-client',
      issuer: 'https://issuer.example.com',
    });
    const jwt = responseOf(await mode.redirect(REDIRECT_URI, { code: 'code-1' }));

    expect(mode.name).toBe('query.jwt');
    expect(decodeJwt(jwt).payload).toEqual({
      code: 'code-1',
      iss: 'https://issuer.example.com',
      aud: 'stored-client',
      exp: NOW_SECONDS + 60,
    });
    expect(await verifyRs256Jwt(jwt, signingKey.publicJwk)).toBe(true);
  });
});
