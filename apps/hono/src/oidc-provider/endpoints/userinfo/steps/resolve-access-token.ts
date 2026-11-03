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
  label: 'アクセストークンを取得して検証する',
  spec: 'OIDC Core 1.0 §5.3.1 / RFC 6750 §3.1 / RFC 9068 §4',
  function: 'resolveUserInfoToken',
  consumes: ['accessToken'],
  produces: ['tokenInfo'],
  removable: false,
});

/**
 * アクセストークンの情報を取得し、検証して返す。
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

  // 提示されたアクセストークンの情報を取得し、登録されていなければ `invalid_token` のエラーを投げる（OIDC Core 1.0 §5.3.1）。
  const tokenInfo = await resolveUserInfoAccessToken(accessToken, accessTokenResolver);

  // 期限切れのアクセストークンは `invalid_token` にする（RFC 6750 §3.1）。
  validateUserInfoTokenExpiration(tokenInfo);

  // トークンが `openid` スコープを含むことを確かめ、含まなければ `insufficient_scope` にする（OIDC Core 1.0 §5.3.1）。
  validateUserInfoScope(tokenInfo);

  // アクセストークンの `aud` に、この UserInfo エンドポイントが含まれることを確かめる（RFC 9068 §4）。
  // トークンエンドポイントは常に `aud` に UserInfo エンドポイントの URL を入れる（`buildAccessTokenAudience`）ので、JWT のトークンでも中身を読めない不透明なトークンでも、既定でこの確認を行う。
  // 確認をやめるときは、第 2 引数に `undefined` を渡す。
  validateUserInfoAudience(tokenInfo, `${c.get('config').issuer}/userinfo`);

  return tokenInfo;
}
