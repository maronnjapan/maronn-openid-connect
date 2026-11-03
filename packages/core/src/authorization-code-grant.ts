import { sha256 } from './crypto-utils.js';
import { TokenError, TokenErrorCode } from './token-error.js';
import type {
  AuthorizationCodeInfo,
  AuthorizationCodeResolver,
  TokenRequestParams,
  ValidatedAuthorizationCodeRequest,
} from './token-request.js';

/**
 * {@link resolveAuthorizationCode} の戻り値。
 *
 * 生パラメータから検証済みの code 文字列も返すことで、後段の consume と
 * validated request 組み立てで optional 値を再度ナローイングせずに使える。
 */
export interface ResolvedAuthorizationCode {
  code: string;
  authorizationCode: AuthorizationCodeInfo;
}

/**
 * PKCE の `code_verifier` が正しければ true を返す。
 *
 * `method` が `S256` なら、`code_verifier` の SHA-256 ハッシュを base64url で符号化した値（`BASE64URL(SHA256(ASCII(code_verifier)))`）を求め、`codeChallenge` と等しければ true を返す。
 * `method` がそれ以外なら false を返す。
 */
export async function verifyCodeChallenge(
  codeVerifier: string,
  codeChallenge: string,
  method: 'S256'
): Promise<boolean> {
  if (method === 'S256') {
    const computed = await sha256(codeVerifier);
    return computed === codeChallenge;
  }
  return false;
}

/**
 * `code` の認可コードをストアから取得して返す。
 *
 * 返す値は、トークンリクエストの `code` の文字列と、ストアから取得した認可コードの情報である。
 * `code` パラメータがないときは `invalid_request` の `TokenError` を、ストアに認可コードがないときは `invalid_grant` の `TokenError` を投げる。
 */
export async function resolveAuthorizationCode(
  params: Pick<TokenRequestParams, 'code'>,
  authCodeResolver: Pick<AuthorizationCodeResolver, 'findAuthorizationCode'>,
): Promise<ResolvedAuthorizationCode> {
  const code = requireAuthorizationCode(params.code);

  const authorizationCode = requireStoredAuthorizationCode(
    await authCodeResolver.findAuthorizationCode(code),
  );

  return { code, authorizationCode };
}

/**
 * 使用済みの認可コードなら `invalid_grant` を投げる。
 *
 * 投げる前に、`authCodeResolver.revokeTokensByGrantId()` があれば、同じグラント ID から発行したトークンを失効させる。
 * 再び提示された使用済みのコードは、漏れている可能性があるためである（OAuth 2.1 §4.1.2、RFC 9700 §4.13）。
 * `revokeTokensByGrantId()` がなければ、トークンを失効させずに投げる。
 * 未使用の認可コードなら何もしない。
 *
 * @spec OAuth 2.1 §4.1.2
 * @spec RFC 9700 §4.13
 */
export async function validateAuthorizationCodeUnused(
  authorizationCode: Pick<AuthorizationCodeInfo, 'used' | 'grantId'>,
  authCodeResolver: Pick<AuthorizationCodeResolver, 'revokeTokensByGrantId'>,
): Promise<void> {
  const used = authorizationCode.used;
  if (!used) {
    return;
  }

  if (authCodeResolver.revokeTokensByGrantId) {
    await authCodeResolver.revokeTokensByGrantId(authorizationCode.grantId);
  }
  validateAuthorizationCodeNotUsed(used);
}

/**
 * 認可コードの発行先が違えば `invalid_grant` を投げる。
 *
 * 認可コードを発行したクライアント（`clientId`）が、認証したクライアント（`authenticatedClientId`）と一致しないときに投げる。
 */
export function validateAuthorizationCodeClient(
  authorizationCode: Pick<AuthorizationCodeInfo, 'clientId'>,
  authenticatedClientId: string,
): void {
  if (authorizationCode.clientId !== authenticatedClientId) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'Authorization code was issued to a different client'
    );
  }
}

/**
 * 期限切れの認可コードなら `invalid_grant` を投げる。
 *
 * JWT の `exp` の扱い（RFC 7519）と同じく、`expiresAt` が `currentTime` 以下なら期限切れとみなす。
 * `currentTime` の既定値は現在時刻（エポック秒）で、生成されたコードから独自の時計の値を渡してもよい。
 */
export function validateAuthorizationCodeExpiration(
  authorizationCode: Pick<AuthorizationCodeInfo, 'expiresAt'>,
  currentTime: number = Math.floor(Date.now() / 1000),
): void {
  if (authorizationCode.expiresAt <= currentTime) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'Authorization code has expired'
    );
  }
}

/**
 * `redirect_uri` を認可コードの保存値と照合する。
 *
 * 認可リクエストで `redirect_uri` を明示していた認可コードなら、トークンリクエストの `redirect_uri` は必須で、保存した値と完全に一致する必要がある。
 * 明示していなかった認可コードでも、トークンリクエストで `redirect_uri` が送られたなら、保存した値との一致を求める。
 * どちらかを満たさないときは `invalid_grant` の `TokenError` を投げる。
 *
 * @spec OIDC Core 1.0 §3.1.3.2
 */
export function validateAuthorizationCodeRedirectUri(
  authorizationCode: Pick<AuthorizationCodeInfo, 'redirectUri' | 'redirectUriExplicit'>,
  requestRedirectUri: string | undefined,
): void {
  if (authorizationCode.redirectUriExplicit) {
    requireTokenRequestRedirectUri(requestRedirectUri);
  }
  validateAuthorizationCodeRedirectUriMatch(
    requestRedirectUri,
    authorizationCode.redirectUri,
  );
}

/**
 * `code_verifier` を検証し、検証できれば true を返す。
 *
 * PKCE の値が保存されていない認可コード（PKCE を省略した互換フロー）には、検証せずに false を返す。
 * 次のときは `invalid_grant` の `TokenError` を投げる:
 * - `code_challenge` と `code_challenge_method` の片方だけが保存されている。
 * - `codeVerifier` がない。
 * - `codeVerifier` の長さか文字が RFC 7636 §4.1 の規則に合わない。
 * - `codeVerifier` から求めた値が `code_challenge` と一致しない。
 */
export async function verifyAuthorizationCodePkce(
  authorizationCode: Pick<AuthorizationCodeInfo, 'codeChallenge' | 'codeChallengeMethod'>,
  codeVerifier: string | undefined,
): Promise<boolean> {
  if (
    !hasPkceBinding(
      authorizationCode.codeChallenge,
      authorizationCode.codeChallengeMethod,
    )
  ) {
    return false;
  }

  const binding = requirePkceBinding(
    authorizationCode.codeChallenge,
    authorizationCode.codeChallengeMethod,
  );
  const verifier = requireCodeVerifier(codeVerifier);
  validateCodeVerifier(verifier);
  await verifyPkceCodeVerifier(
    verifier,
    binding.codeChallenge,
    binding.codeChallengeMethod,
  );

  return true;
}

/**
 * ストアの認可コードを使用済みにする。
 *
 * ストアの更新は `authCodeResolver.revokeAuthorizationCode()` が行う。
 * リゾルバは、レコードを削除せずに `used` を `true` にして残す契約である。
 * 再利用を検知できるように、新しいトークンを発行する前にこの処理を終えておく。
 */
export async function consumeAuthorizationCode(
  code: string,
  authCodeResolver: Pick<AuthorizationCodeResolver, 'revokeAuthorizationCode'>,
): Promise<void> {
  await authCodeResolver.revokeAuthorizationCode(code);
}

/**
 * 認可コードグラントの検証済みリクエストを作って返す。
 *
 * 各ステップの結果（提示された `code`、ストアの認可コード、認証したクライアントの ID、PKCE を検証したかどうか）から作る。
 * `clientId` には認証したクライアントの ID を入れ、`grantId`、`redirectUri`、`scope`、`nonce`、`audience`、`acrValues`、`claims`、`sessionId` には認可コードの値をそのまま入れる。
 */
export function buildValidatedAuthorizationCodeRequest(
  code: string,
  authorizationCode: AuthorizationCodeInfo,
  authenticatedClientId: string,
  codeVerified: boolean,
): ValidatedAuthorizationCodeRequest {
  return {
    grantType: 'authorization_code',
    clientId: authenticatedClientId,
    code,
    grantId: authorizationCode.grantId,
    redirectUri: authorizationCode.redirectUri,
    scope: authorizationCode.scope,
    nonce: authorizationCode.nonce,
    audience: authorizationCode.audience,
    acrValues: authorizationCode.acrValues,
    claims: authorizationCode.claims,
    // オンラインのリフレッシュトークンを、この認可のもとになった認証セッションに結び付けるために引き継ぐ。
    sessionId: authorizationCode.sessionId,
    codeVerified,
  };
}

/**
 * `code` を返し、なければ `invalid_request` を投げる。
 *
 * トークンリクエストの `code` パラメータが空文字列のときも投げる。
 * ストアから認可コードを取得する前に呼ぶ。
 */
export function requireAuthorizationCode(code: string | undefined): string {
  if (!code) {
    throw new TokenError(
      TokenErrorCode.InvalidRequest,
      'Missing required parameter: code'
    );
  }
  return code;
}

/**
 * 認可コードを返し、なければ `invalid_grant` を投げる。
 *
 * ストアから読み取った値を受け取り、`null` か `undefined` なら登録されていない認可コードとみなす。
 */
export function requireStoredAuthorizationCode<T>(authorizationCode: T | null | undefined): T {
  if (!authorizationCode) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'Authorization code not found'
    );
  }
  return authorizationCode;
}

/**
 * `used` が true なら `invalid_grant` を投げる。
 *
 * 再利用されたときのトークンの失効（OAuth 2.1 §4.1.2）は、呼び出し側が先に済ませておく。
 *
 * @spec OAuth 2.1 §4.1.2
 */
export function validateAuthorizationCodeNotUsed(used: boolean | undefined): void {
  if (!used) return;
  throw new TokenError(
    TokenErrorCode.InvalidGrant,
    'Authorization code has already been used'
  );
}

/**
 * `redirect_uri` がなければ `invalid_grant` を投げる。
 *
 * 認可リクエストで `redirect_uri` を明示していた場合に、トークンリクエストにも `redirect_uri` があることを確かめる。
 * 明示していたかどうかは、呼び出し側が判定する。
 * あれば、その値を返す。
 *
 * @spec OIDC Core 1.0 §3.1.3.2
 */
export function requireTokenRequestRedirectUri(redirectUri: string | undefined): string {
  if (!redirectUri) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'redirect_uri is required because it was included in the authorization request'
    );
  }
  return redirectUri;
}

/**
 * `redirect_uri` が違えば `invalid_grant` を投げる。
 *
 * トークンリクエストの `redirect_uri` を、認可時の値（`authorizedRedirectUri`）と文字列として比べる。
 * `redirect_uri` が省略されていれば（`undefined`）、比べずに戻る。
 *
 * @spec OIDC Core 1.0 §3.1.3.2
 */
export function validateAuthorizationCodeRedirectUriMatch(
  requestRedirectUri: string | undefined,
  authorizedRedirectUri: string,
): void {
  if (
    requestRedirectUri !== undefined &&
    requestRedirectUri !== authorizedRedirectUri
  ) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'redirect_uri does not match the authorization request'
    );
  }
}

/**
 * PKCE の値が一つでも保存されていれば true を返す。
 *
 * `codeChallenge` と `codeChallengeMethod` の片方だけがある場合も true を返す。
 * false は、PKCE を省略した互換フローの認可コードであることを表す。
 */
export function hasPkceBinding(
  codeChallenge: string | undefined,
  codeChallengeMethod: 'S256' | undefined,
): boolean {
  return codeChallenge !== undefined || codeChallengeMethod !== undefined;
}

/**
 * PKCE の値が欠けていれば `invalid_grant` を投げる。
 *
 * 認可コードに `code_challenge` と `code_challenge_method` の両方が保存されていれば、二つをまとめて返す。
 * 片方だけが保存された不完全な認可コードは拒否する。
 */
export function requirePkceBinding(
  codeChallenge: string | undefined,
  codeChallengeMethod: 'S256' | undefined,
): { codeChallenge: string; codeChallengeMethod: 'S256' } {
  if (codeChallenge === undefined || codeChallengeMethod === undefined) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'Authorization code PKCE binding is incomplete'
    );
  }
  return { codeChallenge, codeChallengeMethod };
}

/**
 * `code_verifier` がなければ `invalid_grant` を投げる。
 *
 * PKCE を使う認可コードを交換するときに、`code_verifier` があることを確かめる。
 * あれば、その値を返す。
 *
 * @spec RFC 7636 §4.5
 */
export function requireCodeVerifier(codeVerifier: string | undefined): string {
  if (!codeVerifier) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'Missing required parameter: code_verifier'
    );
  }
  return codeVerifier;
}

/**
 * `code_verifier` の長さと文字を検証する。
 *
 * 長さが 43 文字から 128 文字の範囲にないとき、または英数字と `-`、`.`、`_`、`~` 以外の文字を含むときに、`invalid_grant` の `TokenError` を投げる。
 * 使える文字は、URI の非予約文字である。
 *
 * @spec RFC 7636 §4.1
 */
export function validateCodeVerifier(codeVerifier: string): void {
  if (codeVerifier.length < 43 || codeVerifier.length > 128) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'code_verifier length must be between 43 and 128 characters'
    );
  }

  if (!/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'code_verifier contains invalid characters'
    );
  }
}

/**
 * `code_verifier` を `code_challenge` と照合する。
 *
 * `code_verifier` から求めた値が、保存済みの `code_challenge` と一致しなければ `invalid_grant` の `TokenError` を投げる。
 * 値の求め方は `code_challenge_method`（`S256`）に従う（`verifyCodeChallenge()`）。
 *
 * @spec RFC 7636 §4.6
 */
export async function verifyPkceCodeVerifier(
  codeVerifier: string,
  codeChallenge: string,
  codeChallengeMethod: 'S256',
): Promise<void> {
  const isValid = await verifyCodeChallenge(
    codeVerifier,
    codeChallenge,
    codeChallengeMethod
  );
  if (!isValid) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'code_verifier validation failed'
    );
  }
}
