import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthTransaction } from '@maronn-openid-connect/core';
import { requestTo } from '../../../test-support/context';
import { stores } from '../../_oidc-provider/provider';
import { POST } from './route';

afterEach(() => vi.restoreAllMocks());

/** Construct a password submission with independently selected cookie, URL and hidden references. */
function loginRequest(query: string, cookie: string, hidden: string[]): Request {
  const body = new URLSearchParams({ username: 'alice', password: 'password', csrf_token: 'csrf-1' });
  for (const value of hidden) body.append('transaction_id', value);
  return requestTo('/login/submit' + query, {
    method: 'POST',
    headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' },
    body,
  });
}

describe('POST', () => {
  it.each([
    ['', '__Host-oidc_txn=txn-1', ['txn-1']],
    ['?transaction_id=txn-2', '__Host-oidc_txn=txn-1', ['txn-1']],
    ['?transaction_id=txn-1&transaction_id=txn-1', '__Host-oidc_txn=txn-1', ['txn-1']],
    ['?transaction_id=txn-1', '', ['txn-1']],
    ['?transaction_id=txn-1', '__Host-oidc_txn=txn-2', ['txn-1']],
    ['?transaction_id=txn-1', '__Host-oidc_txn=txn-1', []],
    ['?transaction_id=txn-1', '__Host-oidc_txn=txn-1', ['txn-2']],
    ['?transaction_id=txn-1', '__Host-oidc_txn=txn-1', ['txn-1', 'txn-1']],
  ] as const)('should reject inconsistent references before reading the store or authenticating (%s, %s, %j)', async (query, cookie, hidden) => {
    const read = vi.spyOn(stores.transactionStore, 'get');
    const authenticate = vi.spyOn(stores.userStore, 'authenticate');

    const response = await POST(loginRequest(query, cookie, [...hidden]));

    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe('invalid_transaction_binding');
    expect(read).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('should reject an invalid CSRF token before authenticating or updating a transaction', async () => {
    const transaction: AuthTransaction = {
      clientId: 'client-1', redirectUri: 'https://rp.example/callback', redirectUriExplicit: true,
      responseType: 'code', scope: 'openid', csrfToken: 'another-csrf',
      createdAt: Date.now(), expiresAt: Date.now() + 600_000, failedAttempts: 0,
    };
    vi.spyOn(stores.transactionStore, 'get').mockResolvedValue(transaction);
    const save = vi.spyOn(stores.transactionStore, 'put');
    const authenticate = vi.spyOn(stores.userStore, 'authenticate');

    const response = await POST(loginRequest('?transaction_id=txn-1', '__Host-oidc_txn=txn-1', ['txn-1']));

    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe('invalid_csrf_token');
    expect(authenticate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
