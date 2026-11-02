import {
  type AccessTokenInfo,
  type UserInfoResponse,
  generateUserInfoJwt,
  selectSigningKeyByAlg,
  type SigningKey,
} from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../../../config.js';
import { type UserInfoEndpointResponse, UserInfoEndpointError } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'build-response',
  endpoint: 'userinfo',
  kind: 'transform',
  label: 'Build the response (JSON or signed JWT)',
  spec: 'OIDC Core 1.0 §5.3.2',
  function: 'buildUserInfoResponse',
  consumes: ['tokenInfo', 'claims'],
  produces: ['userInfoResponse'],
  removable: false,
});

/**
 * UserInfo のレスポンスを、登録された形式で作る。
 *
 * クライアントが `userinfo_signed_response_alg` を登録していれば、そのアルゴリズムで署名した JWT（`Content-Type: application/jwt`）を、登録していなければ JSON を返す。
 * JWT の `iss` は設定の `issuer`、`aud` はクライアント ID である。
 *
 * @throws {UserInfoEndpointError} 登録されたアルゴリズムの UserInfo の署名鍵がないとき（500 の `server_error`）。
 * @spec OIDC Core 1.0 §5.3.2
 */
export async function buildUserInfoResponse(
  c: any,
  tokenInfo: AccessTokenInfo,
  claims: UserInfoResponse,
): Promise<UserInfoEndpointResponse> {
  const clientResolver = c.get('clientResolver');
  const client = (await clientResolver.findClient(
    tokenInfo.clientId,
  )) as RegisteredClient | null;

  const requestedUserinfoAlg = client?.userinfoSignedResponseAlg;
  if (!requestedUserinfoAlg) {
    return { status: 200, body: claims };
  }

  // 登録した UserInfo の署名鍵から、クライアントが登録したアルゴリズムに一致するものを選ぶ（ID トークンの鍵の選び方と同じ）。
  // クライアントが `userinfo_signed_response_alg` を登録していれば、UserInfo のレスポンスは、常に RS256 で署名するのではなく、登録したアルゴリズム（RS256、ES256 など）で署名した JWS でなければならない（MUST、OIDC Core 1.0 §5.3.2）。
  // 一致する鍵がないのはサーバーの設定の誤りなので、別のアルゴリズムで署名せずに 500 のエラーにする。
  const config = c.get('config');
  const userinfoSigningKeys = (c.get('userinfoSigningKeys') as SigningKey[] | undefined) ?? [];
  let selectedUserinfoKey: SigningKey;
  try {
    selectedUserinfoKey = selectSigningKeyByAlg(userinfoSigningKeys, requestedUserinfoAlg);
  } catch {
    throw new UserInfoEndpointError({
      status: 500,
      body: {
        error: 'server_error',
        error_description: `No UserInfo signing key registered for alg "${requestedUserinfoAlg}"`,
      },
    });
  }
  const jwt = await generateUserInfoJwt(claims, {
    issuer: config.issuer,
    audience: client.clientId,
    privateKey: selectedUserinfoKey.privateKey,
    keyId: selectedUserinfoKey.keyId,
  });
  return { status: 200, text: jwt, headers: { 'Content-Type': 'application/jwt' } };
}
