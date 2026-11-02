import { readBearerToken } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { RegistrationEndpointError } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'verify-initial-access-token',
  endpoint: 'register',
  feature: 'dynamic-client-registration',
  kind: 'validate',
  label: '登録してよいリクエストか確かめる',
  spec: 'OIDC Dynamic Client Registration 1.0 §3 / RFC 6750 §3.1',
  function: 'verifyRegistrationAccess',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * 登録を許すかを確かめ、許さなければ 401 を投げる。
 *
 * ボディを読む前に、設定の `verifyInitialAccessToken` で確かめる（OIDC Dynamic Client Registration 1.0 §3）。
 * 関数を設定していなければ、誰でも登録できる状態として、すべてのリクエストを通す（RFC 7591 §3.1 の SHOULD）。
 * 設定していれば、リクエストは `Bearer` トークン（初期アクセストークン）を送らなければならない（RFC 6750 §2.1）。
 * トークンがなければ、エラーコードのない `WWW-Authenticate: Bearer` を付けた 401 を投げる。
 * 認証情報のないリクエストにはエラーコードを付けないよう、RFC 6750 §3.1 が求めているためである。
 * トークンがあれば設定の関数に渡し、関数が false を返したら `WWW-Authenticate: Bearer error="invalid_token"` を付けた 401 を投げる。
 * ここではトークンそのものを検証せず、どちらのレスポンスにも期待するトークンについての情報を含めない。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §3
 * @spec RFC 6750 §3.1
 * @throws {RegistrationEndpointError} ボディなしの 401: `Bearer` トークンがないとき、または設定の関数がトークンを拒否したとき
 */
export async function verifyRegistrationAccess(c: any): Promise<void> {
  const config = c.get('dynamicClientRegistrationConfig');
  if (config.verifyInitialAccessToken === undefined) return;
  const token = readBearerToken(c.req.header('Authorization'));
  if (token === undefined) {
    throw new RegistrationEndpointError({ status: 401, body: null, headers: { 'WWW-Authenticate': 'Bearer' } });
  }
  if (await config.verifyInitialAccessToken(token, config)) return;
  throw new RegistrationEndpointError({
    status: 401,
    body: null,
    headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
  });
}
