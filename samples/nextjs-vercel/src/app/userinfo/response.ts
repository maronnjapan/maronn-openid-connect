/**
 * What the UserInfo endpoint (route.ts) answers, and the failure a block
 * answers with a fixed response.
 */

/** What the UserInfo endpoint answers; respondUserInfo() of route.ts turns it into HTTP. */
export interface UserInfoEndpointResponse {
  status: number;
  /** A JSON body (application/json). */
  body?: object;
  /** A raw body with its own Content-Type (the signed JWT, application/jwt). */
  text?: string;
  headers?: Record<string, string>;
}

/**
 * A failure a block answers with a fixed response: a malformed request, a
 * missing token (with its Bearer challenge), or a server configuration problem.
 */
export class UserInfoEndpointError extends Error {
  constructor(readonly response: UserInfoEndpointResponse) {
    const details = (response.body ?? {}) as { error?: unknown; error_description?: unknown };
    super(String(details.error_description ?? details.error ?? 'userinfo endpoint error'));
    this.name = 'UserInfoEndpointError';
  }
}
