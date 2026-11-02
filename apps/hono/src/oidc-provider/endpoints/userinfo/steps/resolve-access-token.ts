import {
  resolveUserInfoAccessToken,
  validateUserInfoTokenExpiration,
  validateUserInfoScope,
  validateUserInfoAudience,
  type AccessTokenInfo,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'resolve-access-token',
  endpoint: 'userinfo',
  kind: 'resolve',
  label: 'Resolve and validate the access token',
  spec: 'OIDC Core 1.0 §5.3.1 / RFC 6750 §3.1 / RFC 9068 §4',
  function: 'resolveUserInfoToken',
  consumes: ['accessToken'],
  produces: ['tokenInfo'],
  removable: false,
});

/**
 * 提示されたアクセストークンの情報を取得し、検証して返す。
 *
 * トークンが登録されていること、期限切れでないこと、`openid` スコープを含むこと、オーディエンスにこの UserInfo エンドポイントを含むことを確かめる。
 * どの確認も core の独立した関数で、失敗すると `UserInfoError` を投げ、`respondUserInfoError()` が RFC 6750 の `Bearer` のチャレンジで応答する。
 *
 * @throws {UserInfoError} `invalid_token`: トークンが登録されていない、期限切れ、オーディエンスにこのエンドポイントを含まないとき（401）。
 * @throws {UserInfoError} `insufficient_scope`: トークンが `openid` スコープを含まないとき（403）。
 * @spec OIDC Core 1.0 §5.3.1
 * @spec RFC 6750 §3.1
 * @spec RFC 9068 §4
 */
export async function resolveUserInfoToken(c: any, accessToken: string): Promise<AccessTokenInfo> {
  const accessTokenResolver = c.get('accessTokenResolver');

  // OIDC Core 1.0 §5.3.1: resolve the presented Bearer token (invalid_token when unknown).
  const tokenInfo = await resolveUserInfoAccessToken(accessToken, accessTokenResolver);

  // RFC 6750 §3.1: an expired access token is invalid_token.
  validateUserInfoTokenExpiration(tokenInfo);

  // OIDC Core 1.0 §5.3.1: the token must carry the openid scope (insufficient_scope).
  validateUserInfoScope(tokenInfo);

  // RFC 9068 §4: this UserInfo endpoint must appear in the access token's aud.
  // The token endpoint always stores the UserInfo endpoint URL in aud
  // (buildAccessTokenAudience), so audience validation is on by default for
  // both JWT and opaque tokens. Pass undefined to turn it off.
  validateUserInfoAudience(tokenInfo, `${c.get('config').issuer}/userinfo`);

  return tokenInfo;
}
