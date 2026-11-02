import { noStore } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'revocation',
  feature: 'revocation',
  kind: 'respond',
  label: 'Respond 200 with an empty body',
  spec: 'RFC 7009 §2.2',
  function: 'respondRevocation',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * ボディが空の 200 で応答する。
 *
 * トークンを失効させたときも、トークンが見つからなかったときも、同じレスポンスを返す（RFC 7009 §2.2）。
 * 同じにするので、クライアントはレスポンスの違いから、どのトークンの値が存在するかを探れない。
 * `Cache-Control: no-store` と `Pragma: no-cache` を付ける。
 *
 * @spec RFC 7009 §2.2
 */
export function respondRevocation(c: any): Response {
  noStore(c);
  return c.body(null, 200);
}
