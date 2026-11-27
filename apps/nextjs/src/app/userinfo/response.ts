/**
 * What the UserInfo endpoint (route.ts) answers, the failure a block answers
 * with a fixed response, and the challenges (WWW-Authenticate) of its
 * failures.
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
 * The challenge (RFC 9110 §11.6.1) of one authentication scheme the UserInfo
 * endpoint accepts: the scheme, and the auth-params every challenge of it
 * carries before the error.
 */
export interface UserInfoChallenge {
  readonly scheme: string;
  /** Auth-params such as `realm="UserInfo"`. */
  readonly parameters: readonly string[];
}

/** The challenge of the Bearer scheme (RFC 6750 §3), which every UserInfo endpoint accepts. */
export const BEARER_CHALLENGE: UserInfoChallenge = { scheme: 'Bearer', parameters: ['realm="UserInfo"'] };

/**
 * The challenges a failure of the UserInfo endpoint answers with. route.ts
 * declares them before its first block; the block of a feature that accepts
 * a scheme of its own adds its challenge to `offered`, and sets `scheme` when
 * the request presented its token with it.
 */
export interface UserInfoChallenges {
  /** The challenge of every scheme the endpoint accepts, in the order WWW-Authenticate lists them. */
  readonly offered: UserInfoChallenge[];
  /**
   * The scheme the request presented its access token with: Bearer (the header or the form body, RFC 6750 §2) unless a feature read it.
   * It names the challenge that delivers the error, so it is the `scheme` of one of `offered` exactly (the comparison is case-sensitive), not the scheme as the request spelled it.
   */
  scheme: string;
}

/**
 * The error information a failure delivers in its challenges (RFC 6750 §3):
 * in the challenge of the scheme the request used, or in every challenge when
 * the request presented tokens with several schemes, so the mechanism is
 * ambiguous (RFC 9449 §7.2). Several methods of one scheme (the Bearer header
 * and form body) are not ambiguous. `error` and `errorDescription` are written
 * into quoted-strings as they are, so they use only the characters RFC 6749
 * §5.2 allows (no `"` or `\`), as core's UserInfoError descriptions do.
 */
export interface UserInfoChallengeError {
  readonly error: string;
  readonly errorDescription?: string;
  readonly everyScheme?: boolean;
}

/**
 * A failure a block answers with a fixed response: a malformed request, a
 * missing token, or a server configuration problem.
 */
export class UserInfoEndpointError extends Error {
  constructor(
    readonly response: UserInfoEndpointResponse,
    /**
     * The challenges respondUserInfoError() of route.ts adds to the response:
     * none when omitted; `'without-error'` when the request included no
     * authentication information (RFC 6750 §3.1); otherwise with the error
     * they deliver.
     */
    readonly challenge?: 'without-error' | UserInfoChallengeError,
  ) {
    const details = (response.body ?? {}) as { error?: unknown; error_description?: unknown };
    super(String(details.error_description ?? details.error ?? 'userinfo endpoint error'));
    this.name = 'UserInfoEndpointError';
  }
}

/**
 * 受け付ける認証スキームのチャレンジを、コンマで区切って並べた `WWW-Authenticate` の値を返す。
 *
 * エラーの情報（`error` と `error_description`）は、リクエストがトークンを提示した認証スキーム（`challenges.scheme`）のチャレンジだけに入れ、ほかのスキームのチャレンジには入れない（RFC 9449 §7.2）。
 * どのスキームでトークンを提示したのか決められないリクエスト（`everyScheme`、二つのスキームでトークンを送ったときなど）では、どのスキームのチャレンジにも入れる。
 * `'without-error'` なら、どのチャレンジにもエラーの情報を入れない（認証情報のないリクエスト、RFC 6750 §3.1）。
 * 一つの値に複数のチャレンジを並べてよい（RFC 9110 §11.6.1）。
 *
 * @spec RFC 9449 §7.2
 * @spec RFC 6750 §3
 * @spec RFC 9110 §11.6.1
 */
export function userInfoChallengeHeader(
  challenges: UserInfoChallenges,
  error: 'without-error' | UserInfoChallengeError,
): string {
  return challenges.offered
    .map((challenge) => {
      const parameters = [...challenge.parameters];
      if (error !== 'without-error' && (error.everyScheme === true || challenge.scheme === challenges.scheme)) {
        parameters.push(`error="${error.error}"`);
        if (error.errorDescription !== undefined) parameters.push(`error_description="${error.errorDescription}"`);
      }
      return parameters.length === 0 ? challenge.scheme : `${challenge.scheme} ${parameters.join(', ')}`;
    })
    .join(', ');
}
