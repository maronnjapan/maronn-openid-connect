import type { IntrospectionEndpointResponse } from '../response.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'introspection',
  feature: 'introspection',
  kind: 'respond',
  label: 'Respond (no-store)',
  spec: 'RFC 7662 §2.2',
  function: 'respondIntrospection',
  consumes: ['introspection'],
  produces: [],
  removable: false,
});

/**
 * レスポンスを、キャッシュさせずに返す。
 *
 * `Cache-Control: no-store` と `Pragma: no-cache` と、レスポンスに指定されたヘッダーを付ける（RFC 7662 §2.2）。
 * `text` があればそれをそのままボディにして返し（RFC 9701 の署名付き JWT）、なければ `body` を JSON にして返す。
 *
 * @spec RFC 7662 §2.2
 */
export function respondIntrospection(c: any, response: IntrospectionEndpointResponse): Response {
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
