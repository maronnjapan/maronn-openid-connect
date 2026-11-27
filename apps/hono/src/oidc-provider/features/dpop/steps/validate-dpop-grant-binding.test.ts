import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER } from '../../../../test-support/context.js';
import { dpopKey, dpopProof, type DpopKey } from '../../../../test-support/dpop.js';
import { rs256Key, staticKeyProvider } from '../../../../test-support/keys.js';
import {
  CLIENT_ID,
  NOW,
  REDIRECT_URI,
  confidentialClient,
  storedAuthorizationCode,
  storedRefreshToken,
} from '../../../../test-support/token.js';
import { createApp } from '../../../app.js';
import { createClientKeyResolver, createClientResolver, registerClient } from '../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import { createProviderStores } from '../../../db/memory/stores.js';

const TOKEN_ENDPOINT = `${TEST_ISSUER}/token`;
// RFC 7636 §4.1 / §4.2: a 46-character verifier and its S256 challenge.
const CODE_VERIFIER = 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const CODE_CHALLENGE = 'P2z9-HISyfGmQCy3zRro9mnHlNQpSqpAR_U0x5EiBdU';

interface TokenBody {
  token_type?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

/**
 * The provider on an in-memory database, with the public client client-1
 * (none, which sends its client_id and no credential) registered, and code-1
 * and refresh-1 stored for it, both bound to boundKey when given.
 */
async function provider(boundKey?: DpopKey) {
  const db = createEmptyDatabase();
  const stores = createProviderStores(db);
  await registerClient(db, confidentialClient({ clientSecret: undefined, tokenEndpointAuthMethods: ['none'] }));
  const cnf = boundKey === undefined ? {} : { cnf: { jkt: boundKey.jkt } };
  await stores.authCodeStore.set('code-1', {
    ...storedAuthorizationCode({ codeChallenge: CODE_CHALLENGE, codeChallengeMethod: 'S256' }),
    ...cnf,
  });
  await stores.refreshTokenStore.set('refresh-1', { ...storedRefreshToken({ sessionId: undefined }), ...cnf });
  const app = createApp({
    signingKeyProvider: staticKeyProvider(await rs256Key()),
    storage: stores,
    clientResolver: createClientResolver(db),
    clientKeyResolver: createClientKeyResolver(db),
    config: { issuer: TEST_ISSUER },
  });
  const post = async (fields: Record<string, string>, key?: DpopKey) =>
    app.request(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(key === undefined ? {} : { DPoP: await dpopProof(key, { htm: 'POST', htu: TOKEN_ENDPOINT }) }),
      },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }).toString(),
    });
  const exchangeCode = (key?: DpopKey, code = 'code-1') =>
    post({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER }, key);
  const refresh = (key?: DpopKey, refreshToken = 'refresh-1') =>
    post({ grant_type: 'refresh_token', refresh_token: refreshToken }, key);
  return { stores, exchangeCode, refresh };
}

describe('validateDpopGrantBinding', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // RFC 9449 §10: a code bound to a key is exchanged only with a proof of that key.
  describe('authorization code bound to a key', () => {
    it('should exchange the code with a proof of the key', async () => {
      const key = await dpopKey();
      const { stores, exchangeCode } = await provider(key);

      const response = await exchangeCode(key);

      expect(response.status).toBe(200);
      expect(((await response.json()) as TokenBody).token_type).toBe('DPoP');
      expect((await stores.authCodeStore.get('code-1'))?.used).toBe(true);
    });

    it.each([
      ['without a proof', false, 'The grant is bound to a DPoP key, but no DPoP proof was sent'],
      ['with a proof of another key', true, 'The DPoP proof key does not match the key the grant is bound to'],
    ])('should reject the exchange %s with an uncacheable invalid_grant, and leave the code unused', async (_name, withOtherKey, description) => {
      const key = await dpopKey();
      const { stores, exchangeCode } = await provider(key);

      const response = await exchangeCode(withOtherKey ? await dpopKey() : undefined);

      expect(response.status).toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'invalid_grant', error_description: description });
      expect((await stores.authCodeStore.get('code-1'))?.used).toBe(false);
    });

    // OAuth 2.1 §4.1.2: the grant validation revokes the tokens of a code presented again.
    it('should leave a used code to the grant validation, which rejects the replay', async () => {
      const key = await dpopKey();
      const { stores, exchangeCode } = await provider(key);
      await exchangeCode(key);

      const response = await exchangeCode(await dpopKey());

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_grant', error_description: 'Authorization code has already been used' });
      expect((await stores.authCodeStore.get('code-1'))?.used).toBe(true);
    });

    it('should leave a code of another client to the grant validation', async () => {
      const key = await dpopKey();
      const { stores, exchangeCode } = await provider();
      const otherClientCode = {
        ...storedAuthorizationCode({ code: 'code-2', clientId: 'client-2', codeChallenge: CODE_CHALLENGE, codeChallengeMethod: 'S256' }),
        cnf: { jkt: key.jkt },
      };
      await stores.authCodeStore.set('code-2', otherClientCode);

      const response = await exchangeCode(undefined, 'code-2');

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_grant', error_description: 'Authorization code was issued to a different client' });
    });

    it('should let an unbound code be exchanged without a proof', async () => {
      const { exchangeCode } = await provider();

      const response = await exchangeCode();

      expect(response.status).toBe(200);
      expect(((await response.json()) as TokenBody).token_type).toBe('Bearer');
    });
  });

  // RFC 9449 §5: a public client's bound refresh token needs a proof of the same key.
  describe('refresh token bound to a key', () => {
    it('should refresh with a proof of the key, and bind the rotated refresh token to it', async () => {
      const key = await dpopKey();
      const { stores, refresh } = await provider(key);

      const response = await refresh(key);
      const body = (await response.json()) as TokenBody;

      expect(response.status).toBe(200);
      expect(body.token_type).toBe('DPoP');
      expect(await stores.refreshTokenStore.get(body.refresh_token as string)).toMatchObject({ cnf: { jkt: key.jkt } });
      expect((await stores.refreshTokenStore.get('refresh-1'))?.used).toBe(true);
    });

    it.each([
      ['without a proof', false, 'The grant is bound to a DPoP key, but no DPoP proof was sent'],
      ['with a proof of another key', true, 'The DPoP proof key does not match the key the grant is bound to'],
    ])('should reject the refresh %s with an uncacheable invalid_grant, and leave the refresh token unused', async (_name, withOtherKey, description) => {
      const key = await dpopKey();
      const { stores, refresh } = await provider(key);

      const response = await refresh(withOtherKey ? await dpopKey() : undefined);

      expect(response.status).toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'invalid_grant', error_description: description });
      expect((await stores.refreshTokenStore.get('refresh-1'))?.used).toBe(false);
    });

    // OAuth 2.1 §4.3.1: the grant validation revokes the tokens of a rotated refresh token presented again.
    it('should leave a used refresh token to the grant validation, which rejects the replay and revokes the grant', async () => {
      const key = await dpopKey();
      const { stores, refresh } = await provider(key);
      const rotated = ((await (await refresh(key)).json()) as TokenBody).refresh_token as string;

      const response = await refresh();

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_grant', error_description: 'Refresh token has already been used' });
      expect(await stores.refreshTokenStore.get(rotated)).toBeUndefined();
    });

    it('should let an unbound refresh token be used without a proof, and keep the rotated one unbound', async () => {
      const { stores, refresh } = await provider();

      const response = await refresh();
      const body = (await response.json()) as TokenBody;

      expect(response.status).toBe(200);
      expect(body.token_type).toBe('Bearer');
      expect(await stores.refreshTokenStore.get(body.refresh_token as string)).not.toHaveProperty('cnf');
    });

    // RFC 9449 §5: a refresh token issued to a public client that presents a valid proof is bound to its key.
    it('should bind the refresh token that rotates an unbound one when the public client sends a proof', async () => {
      const key = await dpopKey();
      const { stores, refresh } = await provider();

      const response = await refresh(key);
      const body = (await response.json()) as TokenBody;

      expect(response.status).toBe(200);
      expect(body.token_type).toBe('DPoP');
      expect(await stores.refreshTokenStore.get(body.refresh_token as string)).toMatchObject({ cnf: { jkt: key.jkt } });
    });
  });
});
