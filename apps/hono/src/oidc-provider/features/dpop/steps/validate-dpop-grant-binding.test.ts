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
const CODE_VERIFIER = 'verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const CODE_CHALLENGE = 'P2z9-HISyfGmQCy3zRro9mnHlNQpSqpAR_U0x5EiBdU';

/** A public client (none) with code-1 and refresh-1 stored, bound to boundKey when given. */
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
  const exchangeCode = (key?: DpopKey) =>
    post({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: REDIRECT_URI, code_verifier: CODE_VERIFIER }, key);
  const refresh = (key?: DpopKey) => post({ grant_type: 'refresh_token', refresh_token: 'refresh-1' }, key);
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

  // RFC 9449 §10: a code bound with dpop_jkt is exchanged only with a proof of that key.
  describe('authorization code bound to a key', () => {
    it('should exchange the code with a proof of the key', async () => {
      const key = await dpopKey();
      const { exchangeCode } = await provider(key);

      const response = await exchangeCode(key);

      expect(response.status).toBe(200);
      expect(((await response.json()) as { token_type: string }).token_type).toBe('DPoP');
    });

    it.each([
      ['without a proof', false, 'The grant is bound to a DPoP key, but no DPoP proof was sent'],
      ['with a proof of another key', true, 'The DPoP proof key does not match the key the grant is bound to'],
    ])('should reject the exchange %s, and leave the code unused', async (_name, withOtherKey, description) => {
      const key = await dpopKey();
      const { stores, exchangeCode } = await provider(key);

      const response = await exchangeCode(withOtherKey ? await dpopKey() : undefined);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_grant', error_description: description });
      expect((await stores.authCodeStore.get('code-1'))?.used).toBe(false);
    });

    it('should leave a used code to the grant validation, which detects the replay', async () => {
      const key = await dpopKey();
      const { stores, exchangeCode } = await provider(key);
      await exchangeCode(key);

      const response = await exchangeCode(await dpopKey());

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error_description: string }).error_description).not.toContain('DPoP');
      expect((await stores.authCodeStore.get('code-1'))?.used).toBe(true);
    });
  });

  // RFC 9449 §5: a public client's bound refresh token needs a proof of the same key.
  describe('refresh token bound to a key', () => {
    it('should refresh with a proof of the key, and bind the rotated refresh token to it', async () => {
      const key = await dpopKey();
      const { stores, refresh } = await provider(key);

      const response = await refresh(key);
      const body = (await response.json()) as { token_type: string; refresh_token: string };

      expect(response.status).toBe(200);
      expect(body.token_type).toBe('DPoP');
      expect(await stores.refreshTokenStore.get(body.refresh_token)).toMatchObject({ cnf: { jkt: key.jkt } });
    });

    it.each([
      ['without a proof', false],
      ['with a proof of another key', true],
    ])('should reject the refresh %s', async (_name, withOtherKey) => {
      const key = await dpopKey();
      const { stores, refresh } = await provider(key);

      const response = await refresh(withOtherKey ? await dpopKey() : undefined);

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe('invalid_grant');
      expect((await stores.refreshTokenStore.get('refresh-1'))?.used).toBe(false);
    });

    it('should let an unbound refresh token be used without a proof', async () => {
      const { refresh } = await provider();

      const response = await refresh();

      expect(response.status).toBe(200);
      expect(((await response.json()) as { token_type: string }).token_type).toBe('Bearer');
    });
  });
});
