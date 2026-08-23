/**
 * クライアント登録メタデータ `grant_types` の共有ヘルパー。
 *
 * `grant_types` は「クライアントが token endpoint で使ってよい grant type」を表す登録
 * メタデータであり、認可エンドポイント（`offline_access` を付与してよいか）とトークン
 * エンドポイント（提示された grant_type を使ってよいか）の両方が同じ値を参照する。
 * 既定値の解釈が 2 箇所でずれないよう、判定をこのモジュールへ集約する。
 */

/**
 * `grant_types` 未登録時の既定値。
 *
 * RFC 7591 §2 / OpenID Connect Dynamic Client Registration 1.0 §2:
 * > If omitted, the default is that the client will use only the `authorization_code`
 * > Grant Type.
 *
 * したがって `refresh_token` grant を使うクライアントは明示登録が必要で、
 * 未登録のクライアントは refresh token を「受け取っても使えない」。
 */
export const DEFAULT_CLIENT_GRANT_TYPES: readonly string[] = ['authorization_code'];

/** `grant_types` を持ちうるクライアント登録メタデータの最小形。 */
export interface GrantTypeRegisteredClient {
  grantTypes?: string[];
}

/**
 * クライアントが登録上その grant_type を使ってよいかを返す。
 * 未登録時は {@link DEFAULT_CLIENT_GRANT_TYPES} を適用する。
 */
export function clientAllowsGrantType(
  client: GrantTypeRegisteredClient,
  grantType: string,
): boolean {
  const allowedGrantTypes = client.grantTypes ?? DEFAULT_CLIENT_GRANT_TYPES;
  return allowedGrantTypes.includes(grantType);
}

/**
 * クライアントが `refresh_token` grant を登録しているかを返す。
 *
 * Refresh Token を発行してよいかの判定に使う。登録していないクライアントへ発行しても
 * `grant_type=refresh_token` は `unauthorized_client`（RFC 6749 §5.2）で拒否されるため、
 * 発行は無意味であり、RFC 9700 §4.14 が最小化を求める長期資格情報を無駄に増やす。
 */
export function clientAllowsRefreshTokenGrant(
  client: GrantTypeRegisteredClient,
): boolean {
  return clientAllowsGrantType(client, 'refresh_token');
}
