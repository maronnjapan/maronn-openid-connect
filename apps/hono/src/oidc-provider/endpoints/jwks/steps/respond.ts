import type { JwkSet } from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'respond',
  endpoint: 'jwks',
  kind: 'respond',
  label: 'キャッシュ可能な JWK Set で応答する',
  function: 'respondJwks',
  consumes: ['jwks'],
  produces: [],
  removable: false,
});

/**
 * JWK Set を JSON で返し、1 時間のキャッシュを許す。
 *
 * `Cache-Control: public, max-age=3600` を付け、キャッシュの有効期間をディスカバリーとそろえる。
 */
export function respondJwks(c: any, jwks: JwkSet): Response {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(jwks);
}
