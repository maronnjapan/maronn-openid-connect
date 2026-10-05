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
 * PKCE S256のcode_verifierを検証する
 * code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
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
 * 必須の code パラメータを検証し、保存済み認可コードを解決する。
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
 * 認可コードの再利用を拒否する。
 *
 * OAuth 2.1 §4.1.2 / RFC 9700 §4.13: 使用済みコードが再提示された場合は、
 * 同じ grantId から発行済みのトークンも可能なら失効してから invalid_grant を返す。
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
 * 認可コードが認証済みクライアントへ発行されたものか検証する。
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
 * 認可コードの有効期限を検証する。
 *
 * RFC 7519 の exp 慣例と同じく expiresAt <= currentTime を失効済みとする。
 * currentTime を渡せるため、生成コードで独自クロックを差し込むこともできる。
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
 * Token Request の redirect_uri を認可コードに保存された値と照合する。
 *
 * OIDC Core 1.0 §3.1.3.2: Authorization Request に明示されていた場合は
 * Token Request でも必須かつ完全一致。省略されていた場合も、Token Request で
 * 値が送られたなら保存値との一致を要求する。
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
 * 認可コードに結び付いた PKCE S256 code_verifier を検証する。
 *
 * PKCE binding が無い互換フローなら false、検証成功なら true を返す。
 * challenge / method の片方だけが保存された不完全な binding も拒否する。
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
 * 認可コードを使用済みへ遷移させる。
 *
 * resolver は物理削除ではなく used=true を保持する契約。再利用検知を可能にするため、
 * 新しいトークンを発行する前にこの処理を完了させる。
 */
export async function consumeAuthorizationCode(
  code: string,
  authCodeResolver: Pick<AuthorizationCodeResolver, 'revokeAuthorizationCode'>,
): Promise<void> {
  await authCodeResolver.revokeAuthorizationCode(code);
}

/**
 * 各ステップの結果からバリデーション済み authorization_code request を組み立てる。
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
    // online refresh token をこの認可を生んだ認証セッションへ束縛するために引き継ぐ。
    sessionId: authorizationCode.sessionId,
    codeVerified,
  };
}

/**
 * Token Request の code パラメータがあることを確かめる。ストアを引く前に呼ぶ。
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
 * ストアから読み取った認可コードがあることを確かめる。見つからなければ invalid_grant。
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
 * 認可コードが使用済みでないことを検証する。
 * 再利用時のトークン失効（OAuth 2.1 §4.1.2）は呼び出し側が先に済ませておく前提。
 */
export function validateAuthorizationCodeNotUsed(used: boolean | undefined): void {
  if (!used) return;
  throw new TokenError(
    TokenErrorCode.InvalidGrant,
    'Authorization code has already been used'
  );
}

/**
 * OIDC Core 1.0 §3.1.3.2: Authorization Request に redirect_uri が明示されていた場合に、
 * Token Request にも redirect_uri があることを確かめる。明示の有無の判定は呼び出し側が行う。
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
 * OIDC Core 1.0 §3.1.3.2: Token Request の redirect_uri が認可時の値と一致することを検証する。
 * redirect_uri が省略されていれば検査しない。
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
 * 認可コードに PKCE の値が一つでも保存されているかを返す。
 * false は PKCE を省略した互換フローの認可コードを表す。
 */
export function hasPkceBinding(
  codeChallenge: string | undefined,
  codeChallengeMethod: 'S256' | undefined,
): boolean {
  return codeChallenge !== undefined || codeChallengeMethod !== undefined;
}

/**
 * 認可コードに code_challenge と code_challenge_method の両方が保存されていることを確かめる。
 * 片方だけの不完全な binding は invalid_grant として拒否する。
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
 * RFC 7636 §4.5: PKCE を使う認可コードの交換で code_verifier があることを確かめる。
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
 * RFC 7636 §4.1: code_verifier が 43〜128 文字の unreserved 文字列であることを検証する。
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
 * RFC 7636 §4.6: code_verifier から求めた値が保存済みの code_challenge と一致することを検証する。
 * 一致しなければ invalid_grant。
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
