import { noStore } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'backchannel-authentication',
  feature: 'ciba',
  kind: 'respond',
  label: 'auth_req_id で応答する（no-store）',
  spec: 'CIBA Core 1.0 §7.3',
  function: 'respondBackchannelAuthentication',
  consumes: ['cibaResponse'],
  produces: [],
  removable: false,
});

/**
 * `auth_req_id` を含む JSON を 200 で返す。
 *
 * ボディは `response`（`auth_req_id`、`expires_in`、`interval`）で、認証リクエストを受け付けたことをクライアントに伝える（CIBA §7.3）。
 * `auth_req_id` はトークンの取得に使う秘密の値なので、`noStore()` でトークンレスポンスと同じくキャッシュを禁じる（RFC 6749 §5.1）。
 *
 * @spec CIBA Core 1.0 §7.3
 * @spec RFC 6749 §5.1
 */
export function respondBackchannelAuthentication(c: any, response: object): Response {
  noStore(c);
  return c.json(response);
}
