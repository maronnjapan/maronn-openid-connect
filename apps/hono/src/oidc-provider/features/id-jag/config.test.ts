import { generateIdToken, signingKeysToJwkSet, type JwkSet } from '@maronn-openid-connect/core';
import {
  TOKEN_TYPE_ACCESS_TOKEN,
  TOKEN_TYPE_ID_TOKEN,
  type IdJagActorTokenResolverInput,
} from '@maronn-openid-connect/experimental/id-jag';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER } from '../../../test-support/context.js';
import { nowSeconds } from '../../../test-support/extensions.js';
import { rs256Key } from '../../../test-support/keys.js';
import { idJagConfig, resolveTrustedIdentityProviders } from './config.js';

const defaults = { ...idJagConfig };
const partnerJwks: JwkSet = { keys: [{ kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'partner-1', n: 'n', e: 'AQAB' }] };

afterEach(() => {
  Object.assign(idJagConfig, defaults);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A fetch that answers every request with the JWKS. */
function stubJwksFetch(response: () => Response = () => Response.json(partnerJwks)) {
  const fetch = vi.fn(async (_input: string | URL | Request) => response());
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function actorInput(overrides: Partial<IdJagActorTokenResolverInput> = {}): Promise<IdJagActorTokenResolverInput> {
  const key = await rs256Key();
  const now = nowSeconds();
  return {
    actorToken: await generateIdToken({
      payload: { iss: TEST_ISSUER, sub: 'agent-1', aud: 'rp-1', iat: now, exp: now + 600 },
      privateKey: key.privateKey,
      keyId: key.keyId,
    }),
    actorTokenType: TOKEN_TYPE_ID_TOKEN,
    clientId: 'rp-1',
    issuer: TEST_ISSUER,
    jwks: await signingKeysToJwkSet([key]),
    ...overrides,
  };
}

describe('idJagConfig', () => {
  // Fail safe: nothing is issued or accepted until the trust lists are configured.
  it('should allow no audience, trust no identity provider and refuse actor tokens by default', () => {
    expect(idJagConfig).toEqual({
      allowedAudiences: [],
      idJagLifetimeSeconds: 300,
      allowedScopes: undefined,
      allowRefreshTokenSubjects: true,
      allowActorTokens: false,
      actorTokenResolver: expect.any(Function),
      trustedIdentityProviders: [],
    });
  });

  describe('actorTokenResolver', () => {
    it('should resolve the sub of an ID Token this OP issued to the client as the actor', async () => {
      expect(await idJagConfig.actorTokenResolver!(await actorInput())).toEqual({ sub: 'agent-1' });
    });

    it('should resolve no actor for a token type other than the ID Token', async () => {
      expect(await idJagConfig.actorTokenResolver!(await actorInput({ actorTokenType: TOKEN_TYPE_ACCESS_TOKEN }))).toBeNull();
    });
  });
});

describe('resolveTrustedIdentityProviders', () => {
  it('should use the inline jwks of an entry and skip an entry with neither jwks nor jwksUri', async () => {
    const fetch = stubJwksFetch();
    idJagConfig.trustedIdentityProviders = [
      { issuer: 'https://idp.inline.example', jwks: partnerJwks },
      { issuer: 'https://idp.keyless.example' },
    ];

    expect(await resolveTrustedIdentityProviders()).toEqual([{ issuer: 'https://idp.inline.example', jwks: partnerJwks }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should fetch the JWKS of a jwksUri once and reuse it from the cache', async () => {
    const fetch = stubJwksFetch();
    idJagConfig.trustedIdentityProviders = [{ issuer: 'https://idp.cached.example', jwksUri: 'https://idp.cached.example/jwks' }];

    const first = await resolveTrustedIdentityProviders();
    const second = await resolveTrustedIdentityProviders();

    expect([first, second]).toEqual([
      [{ issuer: 'https://idp.cached.example', jwks: partnerJwks }],
      [{ issuer: 'https://idp.cached.example', jwks: partnerJwks }],
    ]);
    expect(fetch.mock.calls).toEqual([['https://idp.cached.example/jwks']]);
  });

  it('should fetch the JWKS again once the cached copy is 300 seconds old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    const fetch = stubJwksFetch();
    idJagConfig.trustedIdentityProviders = [{ issuer: 'https://idp.rotated.example', jwksUri: 'https://idp.rotated.example/jwks' }];

    await resolveTrustedIdentityProviders();
    vi.setSystemTime(Date.UTC(2026, 0, 1) + 299_999);
    await resolveTrustedIdentityProviders();
    vi.setSystemTime(Date.UTC(2026, 0, 1) + 300_000);
    await resolveTrustedIdentityProviders();

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('should throw when the JWKS cannot be fetched', async () => {
    stubJwksFetch(() => new Response(null, { status: 503 }));
    idJagConfig.trustedIdentityProviders = [{ issuer: 'https://idp.down.example', jwksUri: 'https://idp.down.example/jwks' }];

    await expect(resolveTrustedIdentityProviders()).rejects.toThrow(
      'Fetching the JWKS of trusted IdP https://idp.down.example failed with status 503',
    );
  });
});
