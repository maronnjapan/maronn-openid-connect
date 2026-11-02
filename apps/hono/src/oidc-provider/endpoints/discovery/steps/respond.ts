import { step } from '../../step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'discovery',
  kind: 'respond',
  label: 'キャッシュ可能な JSON で応答する',
  spec: 'RFC 8414 §3.2',
  function: 'respondDiscovery',
  consumes: ['metadata'],
  produces: [],
  removable: false,
});

/**
 * メタデータを JSON で返し、1 時間のキャッシュを許す。
 *
 * ディスカバリーのメタデータはキャッシュしてよい（RFC 8414 §3.2、RFC 9111 §5.2）。
 * `Cache-Control: public, max-age=3600` を付け、キャッシュの有効期間を JWKS エンドポイントとそろえる。
 * クライアントのライブラリが、決まった期間だけメタデータを再利用できるようにするためである。
 *
 * @spec RFC 8414 §3.2
 * @spec RFC 9111 §5.2
 */
export function respondDiscovery(c: any, metadata: Record<string, unknown>): Response {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(metadata);
}
