import { describe, expect, it } from 'vitest';

import { resolveGoogleLoginSubject, type GoogleAccountResolver } from './account-resolver.js';
import { GoogleLoginErrorCode } from './errors.js';
import type { GoogleIdTokenPayload } from './id-token.js';
import { captureRejection, createGoogleIdTokenPayload, expectGoogleLoginError } from './test-helpers.js';

const account = createGoogleIdTokenPayload() as unknown as GoogleIdTokenPayload;

describe('resolveGoogleLoginSubject', () => {
  it('should return the subject resolved from the Google account', async () => {
    const resolver: GoogleAccountResolver = {
      async resolveSubject(payload) {
        return `google:${payload.sub}`;
      },
    };

    expect(await resolveGoogleLoginSubject(account, resolver)).toBe('google:10769150350006150715113082367');
  });

  it('should pass the verified account to the resolver', async () => {
    const seen: GoogleIdTokenPayload[] = [];
    const resolver: GoogleAccountResolver = {
      async resolveSubject(payload) {
        seen.push(payload);
        return 'user-1';
      },
    };

    await resolveGoogleLoginSubject(account, resolver);

    expect(seen).toEqual([account]);
  });

  it('should throw account_not_linked when the resolver returns null', async () => {
    const resolver: GoogleAccountResolver = { resolveSubject: async () => null };

    const error = await captureRejection(resolveGoogleLoginSubject(account, resolver));

    expectGoogleLoginError(error, GoogleLoginErrorCode.AccountNotLinked, 403);
  });

  it('should treat an empty subject as not linked', async () => {
    const resolver: GoogleAccountResolver = { resolveSubject: async () => '' };

    const error = await captureRejection(resolveGoogleLoginSubject(account, resolver));

    expectGoogleLoginError(error, GoogleLoginErrorCode.AccountNotLinked, 403);
  });
});
