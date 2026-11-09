import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { requestTo } from '../../../test-support/context';
import { stores } from '../../_oidc-provider/provider';
import { POST } from './route';

afterEach(() => vi.restoreAllMocks());

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
});
