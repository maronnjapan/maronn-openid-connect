import { describe, expect, it } from 'vitest';
import { BEARER_CHALLENGE, userInfoChallengeHeader, type UserInfoChallenges } from './response.js';

/** The challenges of an endpoint that accepts Bearer and the scheme of a feature, with the scheme the request used. */
function withFeatureScheme(scheme: string): UserInfoChallenges {
  return { offered: [BEARER_CHALLENGE, { scheme: 'DPoP', parameters: ['algs="ES256 PS256"'] }], scheme };
}

describe('userInfoChallengeHeader', () => {
  describe('Bearer alone', () => {
    const bearerOnly: UserInfoChallenges = { offered: [BEARER_CHALLENGE], scheme: 'Bearer' };

    // RFC 6750 §3.1: no error code for a request without authentication information.
    it('should offer the realm alone without an error', () => {
      expect(userInfoChallengeHeader(bearerOnly, 'without-error')).toBe('Bearer realm="UserInfo"');
    });

    // RFC 6750 §3: the error and its description follow the realm.
    it('should put the error and its description after the realm', () => {
      expect(
        userInfoChallengeHeader(bearerOnly, { error: 'invalid_token', errorDescription: 'Access token is invalid' }),
      ).toBe('Bearer realm="UserInfo", error="invalid_token", error_description="Access token is invalid"');
    });

    it('should leave out error_description when the error has no description', () => {
      expect(userInfoChallengeHeader(bearerOnly, { error: 'invalid_request', everyScheme: true })).toBe(
        'Bearer realm="UserInfo", error="invalid_request"',
      );
    });
  });

  describe('Several schemes', () => {
    // RFC 9449 §7.2 Figure 17
    it('should list every challenge without an error when the request included no authentication information', () => {
      expect(userInfoChallengeHeader(withFeatureScheme('Bearer'), 'without-error')).toBe(
        'Bearer realm="UserInfo", DPoP algs="ES256 PS256"',
      );
    });

    // RFC 9449 §7.2 Figure 18
    it('should put the error in the challenge of the scheme the request used alone', () => {
      const error = { error: 'invalid_token', errorDescription: 'Invalid token' };

      expect(userInfoChallengeHeader(withFeatureScheme('Bearer'), error)).toBe(
        'Bearer realm="UserInfo", error="invalid_token", error_description="Invalid token", DPoP algs="ES256 PS256"',
      );
      expect(userInfoChallengeHeader(withFeatureScheme('DPoP'), error)).toBe(
        'Bearer realm="UserInfo", DPoP algs="ES256 PS256", error="invalid_token", error_description="Invalid token"',
      );
    });

    // RFC 9449 §7.2 Figure 19
    it('should put the error in every challenge when the mechanism is ambiguous', () => {
      const error = {
        error: 'invalid_request',
        errorDescription: 'Multiple methods used to include access token',
        everyScheme: true,
      };

      expect(userInfoChallengeHeader(withFeatureScheme('Bearer'), error)).toBe(
        'Bearer realm="UserInfo", error="invalid_request", error_description="Multiple methods used to include access token", ' +
          'DPoP algs="ES256 PS256", error="invalid_request", error_description="Multiple methods used to include access token"',
      );
    });

    // RFC 9110 §11.6.1: a challenge may be the scheme name alone.
    it('should write a challenge without auth-params as its scheme name', () => {
      const challenges: UserInfoChallenges = { offered: [{ scheme: 'Bearer', parameters: [] }], scheme: 'Bearer' };

      expect(userInfoChallengeHeader(challenges, 'without-error')).toBe('Bearer');
    });
  });
});
