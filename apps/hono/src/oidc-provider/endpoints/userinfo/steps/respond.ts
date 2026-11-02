import type { UserInfoEndpointResponse } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'userinfo',
  kind: 'respond',
  label: '応答する（no-store）',
  spec: 'RFC 6750 §5.2',
  function: 'respondUserInfo',
  consumes: ['userInfoResponse'],
  produces: [],
  removable: false,
});

/**
 * キャッシュを禁じて UserInfo のレスポンスを返す。
 *
 * `Cache-Control: no-store` と `Pragma: no-cache` に加えて、レスポンスのヘッダーを付ける。
 * `text` があればそのままボディにし、なければ `body` を JSON で返す。
 *
 * UserInfo のレスポンスは成功でもエラーでも個人情報にかかわるので、プロキシなどの中継者にもキャッシュさせてはならない（RFC 6750 §5.2、OIDC Core 1.0 §16.4）。
 *
 * @spec RFC 6750 §5.2
 * @spec OIDC Core 1.0 §16.4
 */
export function respondUserInfo(c: any, response: UserInfoEndpointResponse): Response {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    c.header(name, value);
  }
  if (response.text !== undefined) {
    return c.body(response.text, response.status);
  }
  return c.json(response.body ?? {}, response.status);
}
