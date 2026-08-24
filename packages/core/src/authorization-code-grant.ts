import { sha256 } from './crypto-utils.js';
import { TokenError, TokenErrorCode } from './token-error.js';
import type {
  AuthorizationCodeInfo,
  AuthorizationCodeResolver,
  TokenRequestContext,
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
async function verifyCodeChallenge(
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
  params: TokenRequestParams,
  authCodeResolver: AuthorizationCodeResolver,
): Promise<ResolvedAuthorizationCode> {
  const code = params.code;
  if (!code) {
    throw new TokenError(
      TokenErrorCode.InvalidRequest,
      'Missing required parameter: code'
    );
  }

  const authorizationCode =
    await authCodeResolver.findAuthorizationCode(code);
  if (!authorizationCode) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'Authorization code not found'
    );
  }

  return { code, authorizationCode };
}

/**
 * 認可コードの再利用を拒否する。
 *
 * OAuth 2.1 §4.1.2 / RFC 9700 §4.13: 使用済みコードが再提示された場合は、
 * 同じ grantId から発行済みのトークンも可能なら失効してから invalid_grant を返す。
 */
export async function validateAuthorizationCodeUnused(
  authorizationCode: AuthorizationCodeInfo,
  authCodeResolver: AuthorizationCodeResolver,
): Promise<void> {
  if (!authorizationCode.used) {
    return;
  }

  if (authCodeResolver.revokeTokensByGrantId) {
    await authCodeResolver.revokeTokensByGrantId(authorizationCode.grantId);
  }
  throw new TokenError(
    TokenErrorCode.InvalidGrant,
    'Authorization code has already been used'
  );
}

/**
 * 認可コードが認証済みクライアントへ発行されたものか検証する。
 */
export function validateAuthorizationCodeClient(
  authorizationCode: AuthorizationCodeInfo,
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
  authorizationCode: AuthorizationCodeInfo,
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
  authorizationCode: AuthorizationCodeInfo,
  requestRedirectUri: string | undefined,
): void {
  if (authorizationCode.redirectUriExplicit) {
    if (!requestRedirectUri) {
      throw new TokenError(
        TokenErrorCode.InvalidGrant,
        'redirect_uri is required because it was included in the authorization request'
      );
    }
    if (requestRedirectUri !== authorizationCode.redirectUri) {
      throw new TokenError(
        TokenErrorCode.InvalidGrant,
        'redirect_uri does not match the authorization request'
      );
    }
    return;
  }

  if (
    requestRedirectUri !== undefined &&
    requestRedirectUri !== authorizationCode.redirectUri
  ) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'redirect_uri does not match the authorization request'
    );
  }
}

/**
 * 認可コードに結び付いた PKCE S256 code_verifier を検証する。
 *
 * PKCE binding が無い互換フローなら false、検証成功なら true を返す。
 * challenge / method の片方だけが保存された不完全な binding も拒否する。
 */
export async function verifyAuthorizationCodePkce(
  authorizationCode: AuthorizationCodeInfo,
  codeVerifier: string | undefined,
): Promise<boolean> {
  const hasPkceBinding =
    authorizationCode.codeChallenge !== undefined ||
    authorizationCode.codeChallengeMethod !== undefined;
  if (!hasPkceBinding) {
    return false;
  }

  if (
    authorizationCode.codeChallenge === undefined ||
    authorizationCode.codeChallengeMethod === undefined
  ) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'Authorization code PKCE binding is incomplete'
    );
  }

  if (!codeVerifier) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'Missing required parameter: code_verifier'
    );
  }

  // RFC 7636 §4.1: code_verifier is 43-128 unreserved characters.
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

  const isValid = await verifyCodeChallenge(
    codeVerifier,
    authorizationCode.codeChallenge,
    authorizationCode.codeChallengeMethod
  );
  if (!isValid) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'code_verifier validation failed'
    );
  }

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
  authCodeResolver: AuthorizationCodeResolver,
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
 * authorization_code グラント固有の検証を行う合成関数。
 *
 * 後方互換の高水準 API として、機能単位のステップ関数を安全な順序で呼び出す。
 * CLI 生成コードはカスタマイズしやすいよう、下記ステップを直接呼び出す。
 *
 * 1. {@link resolveAuthorizationCode}
 * 2. {@link validateAuthorizationCodeUnused}
 * 3. {@link validateAuthorizationCodeClient}
 * 4. {@link validateAuthorizationCodeExpiration}
 * 5. {@link validateAuthorizationCodeRedirectUri}
 * 6. {@link verifyAuthorizationCodePkce}
 * 7. {@link consumeAuthorizationCode}
 * 8. {@link buildValidatedAuthorizationCodeRequest}
 *
 * grant_type の検証・クライアント認証・クライアント別 grant 認可を含む
 * フルの検証経路は {@link validateTokenRequest} が担う。この関数を直接使う場合、
 * それらの前段検証は呼び出し側の責務となる。
 *
 * @throws {TokenError} バリデーションエラー
 */
export async function validateAuthorizationCodeGrant(
  context: TokenRequestContext
): Promise<ValidatedAuthorizationCodeRequest> {
  const { params, authCodeResolver, authenticatedClientId } = context;
  const { code, authorizationCode } = await resolveAuthorizationCode(
    params,
    authCodeResolver,
  );

  await validateAuthorizationCodeUnused(authorizationCode, authCodeResolver);
  validateAuthorizationCodeClient(authorizationCode, authenticatedClientId);
  validateAuthorizationCodeExpiration(authorizationCode);
  validateAuthorizationCodeRedirectUri(
    authorizationCode,
    params.redirect_uri,
  );
  const codeVerified = await verifyAuthorizationCodePkce(
    authorizationCode,
    params.code_verifier,
  );
  await consumeAuthorizationCode(code, authCodeResolver);

  return buildValidatedAuthorizationCodeRequest(
    code,
    authorizationCode,
    authenticatedClientId,
    codeVerified,
  );
}
