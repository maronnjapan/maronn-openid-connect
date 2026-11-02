import type { TokenEndpointResponse } from '../response.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'token',
  kind: 'respond',
  label: 'Respond (no-store)',
  spec: 'RFC 6749 §5.1',
  function: 'respondToken',
  consumes: ['tokenResponse'],
  produces: [],
  removable: false,
});

/**
 * レスポンスを、キャッシュさせない JSON で返す。
 *
 * `Cache-Control: no-store` と `Pragma: no-cache` と、レスポンスに指定されたヘッダーを付け、ボディを JSON にしてそのステータスコードで返す。
 * トークンレスポンスもエラーレスポンスも、キャッシュさせてはならない（MUST NOT）ためである。
 *
 * @spec RFC 6749 §5.1
 * @spec RFC 6749 §5.2
 */
export function respondToken(c: any, response: TokenEndpointResponse): Response {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    c.header(name, value);
  }
  return c.json(response.body, response.status);
}
