import {
  CibaVerificationError,
  createInMemoryCibaAuthenticationRequestStore,
} from '@maronn-openid-connect/experimental/ciba';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingCibaRecord } from '../../../../../test-support/browser-flows.js';
import { contextOf } from '../../../../../test-support/context.js';
import { listPendingRequests, remainingSeconds, verificationFailure } from './outcome.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

describe('verificationFailure', () => {
  it('should turn a CibaVerificationError into an error outcome with its status', () => {
    expect(verificationFailure(new CibaVerificationError('The sign-in request could not be verified', 403))).toEqual({
      kind: 'error',
      error: 'The sign-in request could not be verified',
      statusCode: 403,
    });
  });

  it('should rethrow any other error', () => {
    const error = new Error('store is down');

    expect(() => verificationFailure(error)).toThrow(error);
  });
});

describe('remainingSeconds', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should round a partial second up', () => {
    expect(remainingSeconds(new Date(NOW.getTime() + 59_001))).toBe(60);
  });

  it('should return 0 once the time has passed', () => {
    expect(remainingSeconds(new Date(NOW.getTime() - 1_000))).toBe(0);
  });
});

describe('listPendingRequests', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // CIBA Core 1.0 §7.1: the screen shows the client, the scopes and the binding_message.
  it("should list only the subject's pending requests with a freshly rotated csrf_token each", async () => {
    const store = createInMemoryCibaAuthenticationRequestStore();
    const mine = pendingCibaRecord({ bindingMessage: 'W4SCT', csrfToken: 'old-token' });
    await store.save(mine);
    await store.save(pendingCibaRecord({ subject: 'bob' }));
    await store.save(pendingCibaRecord({ status: 'approved' }));
    await store.save(pendingCibaRecord({ expiresAt: NOW }));

    const requests = await listPendingRequests(contextOf(undefined, { cibaAuthenticationRequestStore: store }), 'alice');

    expect(requests).toEqual([
      {
        authReqId: mine.authReqId,
        clientId: 'ciba-client',
        scopes: ['openid', 'profile'],
        bindingMessage: 'W4SCT',
        expiresInSeconds: 120,
        csrfToken: mine.csrfToken,
      },
    ]);
    expect(mine.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
