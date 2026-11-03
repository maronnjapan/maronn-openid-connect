import {
  generateRandomString,
  type ValidatedTokenRequest,
  TokenError,
  TokenErrorCode,
} from '@maronn-openid-connect/core';
import type { RefreshTokenDecision } from './decide-refresh-token-issuance.js';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'issue-refresh-token',
  endpoint: 'token',
  feature: 'refresh-token',
  kind: 'issue',
  label: 'リフレッシュトークンを発行して保存する',
  spec: 'OAuth 2.1 §4.3.1 / §6.1',
  function: 'issueRefreshToken',
  consumes: ['refreshTokenDecision', 'subject', 'authTime', 'nonce', 'validatedRequest', 'issuedAt', 'audience', 'acr', 'amr'],
  produces: ['refreshToken'],
  removable: false,
});

/**
 * リフレッシュトークンを発行し、保存して返す。
 *
 * 発行しないと決めたときは、何もせずに `undefined` を返す。
 * 発行するときは、ランダムな文字列のリフレッシュトークンを作り、ローテーションに使うレコードをストアに保存する。
 * `authTime` が `undefined` なら、`TokenError`（`invalid_grant`）を投げる。
 * 有効期限は、最初に発行した時刻に設定の `refreshTokenAbsoluteLifetime` を足した時刻で、ローテーションしても延びない。
 *
 * `grantId`、`audience`、`authTime`、`acr`、`amr`、`azp` は、ローテーションしても同じ値を引き継ぐ。
 * 引き継ぐので、認可コードが再利用されたときに後から発行したトークンもまとめて失効させられ、`aud` が広がることもなく、リフレッシュで発行し直す ID トークンは最初の認証のときの値を保つ（OIDC Core 1.0 §12.1）。
 * `nonce` は最初の発行のときだけ保存し、ローテーションでは引き継がない（リフレッシュでは `undefined` になる）。
 *
 * @spec OAuth 2.1 §4.3.1
 * @spec OAuth 2.1 §6.1
 * @spec OIDC Core 1.0 §12.1
 */
export async function issueRefreshToken(
  c: any,
  input: {
    decision: RefreshTokenDecision;
    subject: string;
    authTime: number | undefined;
    nonce: string | undefined;
    validatedRequest: ValidatedTokenRequest;
    issuedAt: number;
    audience: string[];
    acr: string | undefined;
    amr: string[] | undefined;
  },
): Promise<string | undefined> {
  const { decision, subject, authTime, nonce, validatedRequest, issuedAt, audience, acr, amr } = input;
  if (!decision.issueRefreshToken) return undefined;

  const refreshTokenStore = c.get('refreshTokenStore');
  const config = c.get('config');
  const refreshToken = generateRandomString(32);

  // `authTime` がなければ、リフレッシュトークンを発行せずに `invalid_grant` で拒否する。
  // ここでは `authTime` が決まっているはずである（`authorization_code` グラントでは認可コードの `authTime`、`refresh_token` グラントでは `validatedRequest.authTime`）。
  if (authTime === undefined) {
    throw new TokenError(
      TokenErrorCode.InvalidGrant,
      'authTime is required to issue a refresh token',
    );
  }
  // リフレッシュトークンの有効期限は、最初に発行した時刻から数えた絶対的な期間だけで決める（OAuth 2.1 §6.1）。
  // ローテーションしても最初の発行時刻（`originalIssuedAt`）を引き継ぎ、`expiresAt` をそこから数えた期限に固定する。
  // 使うたびに期限を延ばす方式はとらないので、リフレッシュを繰り返しても有効期限は先に延びず、漏れたリフレッシュトークンが長く使われることを防ぐ。
  // - `authorization_code` グラント: 今回が最初の発行なので、`originalIssuedAt` は `issuedAt` と同じ。
  // - `refresh_token` グラント: 元のリフレッシュトークンの `originalIssuedAt` をそのまま引き継ぐ。
  const originalIssuedAt =
    validatedRequest.grantType === 'refresh_token'
      ? validatedRequest.originalIssuedAt
      : issuedAt;
  const refreshTokenExpiresAt = originalIssuedAt + config.refreshTokenAbsoluteLifetime;
  // 保存するリフレッシュトークンのスコープには、グラントが `offline_access` を持つ限り `offline_access` を残す（RFC 6749 §6）。
  // 狭めたスコープ（`validatedRequest.scope`）から `offline_access` が外れても、次のローテーションを続けられるようにするためである。
  // アクセストークンには `validatedRequest.scope` をそのまま使うので、このリクエストで発行するトークンの権限は狭めたままになる。
  const refreshTokenScope =
    decision.grantHasOfflineAccess && !validatedRequest.scope.includes('offline_access')
      ? [...validatedRequest.scope, 'offline_access']
      : validatedRequest.scope;
  await refreshTokenStore.set(refreshToken, {
    subject,
    clientId: validatedRequest.clientId,
    scope: refreshTokenScope,
    expiresAt: refreshTokenExpiresAt,
    originalIssuedAt,
    used: false,
    grantId: validatedRequest.grantId,
    iat: issuedAt,
    issuer: config.issuer,
    audience,
    authTime,
    nonce,
    // リフレッシュで発行し直す ID トークンには、最初の認証のときの `acr` と `amr` を入れる（OIDC Core 1.0 §12.1）。
    // - `authorization_code` グラント: `resolveTokenAcrAmr()` が決めた値を保存する。
    // - `refresh_token` グラント: 保存済みの値を引き継ぐ（リゾルバは呼んでいない）。
    acr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.acr : acr,
    amr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.amr : amr,
    azp: validatedRequest.grantType === 'refresh_token' ? validatedRequest.azp : undefined,
    // オンラインのリフレッシュトークンを結び付けるセッションを保存する。
    // `undefined` なら、セッションに結び付かないオフラインのリフレッシュトークンになり、ログアウトした後も使える。
    sessionId: decision.boundSessionId,
  });

  return refreshToken;
}
