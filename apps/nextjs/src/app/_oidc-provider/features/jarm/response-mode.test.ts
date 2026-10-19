import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt, verifyRs256Jwt } from '../../../../test-support/jwt';
import { es256Key, providerSigningKeys, rs256Key } from '../../../../test-support/keys';
import { locationOf } from '../../../../test-support/responses';
import { jarmResponseMode, jarmResponseModeHandler, selectJarmSigningKey } from './response-mode';

const ISSUER = 'https://op.example.com';
const REDIRECT_URI = 'https://rp.example.com/callback';
/** 2026-01-01T00:00:00Z in Unix seconds. */
const NOW_SECONDS = 1767225600;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_SECONDS * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

/** The response JWT of a redirect URL (JARM §2.3.1). */
function responseOf(location: string): string {
  return new URL(location).searchParams.get('response') ?? '';
}

describe('jarmResponseMode', () => {
  it('should be named query.jwt', async () => {
    const mode = jarmResponseMode({ issuer: ISSUER, clientId: 'client-1', signingKey: await rs256Key() });

    expect(mode.name).toBe('query.jwt');
  });

  // JARM §2.3.1: the only parameter added to the redirect URI is response.
  it('should add the response parameter as the only parameter of the redirect URI', async () => {
    const mode = jarmResponseMode({ issuer: ISSUER, clientId: 'client-1', signingKey: await rs256Key() });

    const location = new URL(locationOf(await mode.respond(`${REDIRECT_URI}?tenant=a`, { code: 'code-1', state: 'state-1' })));

    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect([...location.searchParams.keys()]).toEqual(['tenant', 'response']);
  });

  // JARM §2.1 / §3: iss, aud and exp (60 seconds, jarmConfig) beside the
  // response parameters, signed with RS256.
  it('should put a JWT of the parameters with iss, aud and exp, signed with RS256, in the response parameter', async () => {
    const signingKey = await rs256Key();
    const mode = jarmResponseMode({ issuer: ISSUER, clientId: 'client-1', signingKey });

    const jwt = responseOf(locationOf(await mode.respond(REDIRECT_URI, { code: 'code-1', state: 'state-1' })));

    expect(decodeJwt(jwt)).toEqual({
      header: { alg: 'RS256', kid: 'test-rs256-key' },
      payload: { code: 'code-1', state: 'state-1', iss: ISSUER, aud: 'client-1', exp: NOW_SECONDS + 60 },
    });
    expect(await verifyRs256Jwt(jwt, signingKey.publicJwk)).toBe(true);
  });

  // JARM §2.1: a request without state gets a response JWT without the state claim.
  it('should leave out a parameter whose value is undefined', async () => {
    const mode = jarmResponseMode({ issuer: ISSUER, clientId: 'client-1', signingKey: await rs256Key() });

    const jwt = responseOf(locationOf(await mode.respond(REDIRECT_URI, { error: 'access_denied', state: undefined })));

    expect(decodeJwt(jwt).payload).toEqual({ error: 'access_denied', iss: ISSUER, aud: 'client-1', exp: NOW_SECONDS + 60 });
  });
});

describe('selectJarmSigningKey', () => {
  // JARM §3: the response JWT is RS256, whichever key comes first in the set.
  it('should pick the RS256 key of the general keys when an ES256 key comes first', async () => {
    const rs256 = await rs256Key();

    expect(selectJarmSigningKey(providerSigningKeys(await es256Key(), rs256))).toBe(rs256);
  });

  it('should throw when no RS256 key is registered', async () => {
    const keys = providerSigningKeys(await es256Key());

    expect(() => selectJarmSigningKey(keys)).toThrow(
      'No signing key registered for alg "RS256"',
    );
  });
});

describe('jarmResponseModeHandler', () => {
  it('should restore the response mode named query.jwt', () => {
    expect(jarmResponseModeHandler.names).toEqual(['query.jwt']);
  });

  // JARM §2.3: /consent answers in the mode the stored transaction asked for.
  it('should restore a mode that signs for the stored client and issuer with a key of the loader it is given', async () => {
    const signingKey = await rs256Key('jarm-restore-key');
    const loadSigningKeys = vi.fn(async () => providerSigningKeys(await es256Key(), signingKey));

    const mode = await jarmResponseModeHandler.restore({
      name: 'query.jwt',
      clientId: 'stored-client',
      issuer: 'https://issuer.example.com',
      loadSigningKeys,
    });
    const jwt = responseOf(locationOf(await mode.respond(REDIRECT_URI, { code: 'code-1' })));

    expect(mode.name).toBe('query.jwt');
    expect(loadSigningKeys).toHaveBeenCalledTimes(1);
    expect(decodeJwt(jwt)).toEqual({
      header: { alg: 'RS256', kid: 'jarm-restore-key' },
      payload: { code: 'code-1', iss: 'https://issuer.example.com', aud: 'stored-client', exp: NOW_SECONDS + 60 },
    });
    expect(await verifyRs256Jwt(jwt, signingKey.publicJwk)).toBe(true);
  });

  it('should fail when the loader it is given fails', async () => {
    const loadSigningKeys = vi.fn(async () => {
      throw new Error('Signing key set must contain at least one key');
    });

    await expect(
      jarmResponseModeHandler.restore({ name: 'query.jwt', clientId: 'stored-client', issuer: ISSUER, loadSigningKeys }),
    ).rejects.toThrow('Signing key set must contain at least one key');
  });
});
