import type { ParEndpointResponse } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'par',
  feature: 'par',
  kind: 'respond',
  label: 'Respond 201 (no-store)',
  spec: 'RFC 9126 §2.2',
  function: 'respondPar',
  consumes: ['parResponse'],
  produces: [],
  removable: false,
});

/**
 * レスポンスの JSON を、キャッシュを禁止して返す。
 *
 * `Cache-Control: no-cache, no-store` と `Pragma: no-cache` を付け、ステップが指定したヘッダー（`WWW-Authenticate` など）を加えて、指定のステータスコードで応答する（RFC 9126 §2.2）。
 *
 * @spec RFC 9126 §2.2
 */
export function respondPar(c: any, response: ParEndpointResponse): Response {
  c.header('Cache-Control', 'no-cache, no-store');
  c.header('Pragma', 'no-cache');
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    c.header(name, value);
  }
  return c.json(response.body, response.status);
}
