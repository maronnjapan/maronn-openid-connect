/**
 * What the UserInfo endpoint answers, and the failure a step answers with a
 * fixed response.
 */

/**
 * The challenge (WWW-Authenticate, RFC 7235 §2.1) a failure of the UserInfo
 * endpoint answers with: the authentication scheme the token was presented
 * with, and the auth-params added after error and error_description. The
 * Bearer challenge of RFC 6750 §3, unless a feature reads a token of its own
 * scheme (dpop: DPoP, with the algs it accepts, RFC 9449 §7.1).
 */
export interface UserInfoChallenge {
  scheme: string;
  /** Auth-params after error_description, such as `algs="ES256 PS256"`. */
  parameters?: string;
}

/** The challenge of a Bearer token (RFC 6750 §3). */
export const BEARER_CHALLENGE: UserInfoChallenge = { scheme: 'Bearer' };

/** What the UserInfo endpoint answers; respondUserInfo() turns it into HTTP. */
export interface UserInfoEndpointResponse {
  status: number;
  /** A JSON body (application/json). */
  body?: object;
  /** A raw body with its own Content-Type (the signed JWT, application/jwt). */
  text?: string;
  headers?: Record<string, string>;
}

/**
 * A failure a step answers with a fixed response: a malformed request, a
 * missing token (with its Bearer challenge), or a server configuration problem.
 */
export class UserInfoEndpointError extends Error {
  constructor(readonly response: UserInfoEndpointResponse) {
    const details = (response.body ?? {}) as { error?: unknown; error_description?: unknown };
    super(String(details.error_description ?? details.error ?? 'userinfo endpoint error'));
    this.name = 'UserInfoEndpointError';
  }
}
