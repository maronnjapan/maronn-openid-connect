import { createAuthTransaction } from '@maronn-openid-connect/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { requestTo } from '../../../test-support/context';
import { createDatabase, registerClient } from '../../_oidc-provider/db';
import { stores } from '../../_oidc-provider/provider';
import { POST } from './route';

// provider.ts keeps its stores in the key-value store of db/ (in memory for
// the tests, vitest.config.ts) for the whole file, so every test approves a
// transaction of its own.

const CLIENT_ID = 'consent-decision-client';
const REDIRECT_URI = 'https://rp.example.com/callback';
/** RFC 7636 Appendix B: the S256 code_challenge of its example code_verifier. */
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

beforeAll(async () => {
  await registerClient(createDatabase(), { clientId: CLIENT_ID, redirectUris: [REDIRECT_URI] });
});

afterEach(() => vi.restoreAllMocks());

/**
 * Store a code flow transaction (with the members a feature added to it), sign
 * the End-User in for it, approve it from the consent screen and return where
 * the answer redirects to and the stored code it carries.
 */
async function approve(transactionId: string, added: Record<string, unknown> = {}) {
  const transaction = {
    ...createAuthTransaction(
      {
        responseType: 'code',
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        redirectUriExplicit: true,
        scope: ['openid'],
        state: 'state-1',
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: 'S256',
      },
      'csrf-1',
    ),
    ...added,
  };
  await stores.transactionStore.put('auth_txn:' + transactionId, transaction, 600);
  await stores.authSessionStore.set(transactionId, { subject: 'consent-decision-user', authTime: Math.floor(Date.now() / 1000) - 30 });
  const response = await POST(new NextRequest(requestTo(`/consent/decision?transaction_id=${transactionId}`, {
    method: 'POST',
    headers: { Cookie: `__Host-oidc_txn=${transactionId}`, 'Sec-Fetch-Site': 'same-origin' },
    body: new URLSearchParams({ transaction_id: transactionId, csrf_token: 'csrf-1', action: 'approve' }),
  })));
  const location = new URL(response.headers.get('Location') ?? '');
  const code = location.searchParams.get('code') ?? '';
  return { target: location.origin + location.pathname, stored: await stores.authCodeStore.get(code) };
}

describe('POST', () => {
  it.each(['approve', 'deny'])('should reject a mismatched transaction before processing %s or changing its stores', async (action) => {
    const read = vi.spyOn(stores.transactionStore, 'get');
    const remove = vi.spyOn(stores.transactionStore, 'delete');
    const removeSession = vi.spyOn(stores.authSessionStore, 'delete');
    const issue = vi.spyOn(stores.authCodeStore, 'set');
    const request = new NextRequest(requestTo('/consent/decision?transaction_id=txn-1', {
      method: 'POST',
      headers: { Cookie: '__Host-oidc_txn=txn-1', 'Sec-Fetch-Site': 'same-origin' },
      body: new URLSearchParams({ transaction_id: 'txn-2', csrf_token: 'csrf-1', action }),
    }));

    const response = await POST(request);

    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe('invalid_transaction_binding');
    expect(read).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(removeSession).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  // RFC 9449 §10: the code of a request bound to a key with dpop_jkt (the dpop
  // extension) carries the key of the transaction to the token endpoint.
  describe('Key binding of the request', () => {
    it('should carry the confirmation of the transaction into the code it issues', async () => {
      const cnf = { jkt: 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs' };

      const approved = await approve('consent-decision-txn-cnf', { cnf });

      expect(approved).toMatchObject({ target: REDIRECT_URI, stored: { clientId: CLIENT_ID, subject: 'consent-decision-user', cnf } });
    });

    it('should store the code of a transaction that is not bound without cnf', async () => {
      const approved = await approve('consent-decision-txn-no-cnf');

      expect(approved).toMatchObject({ target: REDIRECT_URI, stored: { clientId: CLIENT_ID, subject: 'consent-decision-user' } });
      expect(approved.stored).not.toHaveProperty('cnf');
    });
  });
});
