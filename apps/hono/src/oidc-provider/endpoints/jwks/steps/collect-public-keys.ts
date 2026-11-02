import type { SigningKey } from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'collect-public-keys',
  endpoint: 'jwks',
  kind: 'resolve',
  label: 'Collect every registered signing key',
  function: 'collectPublishedKeys',
  consumes: [],
  produces: ['keys'],
  removable: false,
});

/**
 * 登録したすべての署名鍵を集めて返す。
 *
 * 用途ごとの鍵の集合（リクエストコンテキストの `signingKeys`、`idTokenSigningKeys`、`userinfoSigningKeys`）を、この順につないで返す。
 * 設定されていない集合は空として扱う。
 *
 * 入れ替えで使わなくなった鍵も含めてすべて公開するので、その鍵で署名したトークンは、有効期限が切れるまで検証できる。
 */
export function collectPublishedKeys(c: any): SigningKey[] {
  return [
    ...((c.get('signingKeys') as SigningKey[] | undefined) ?? []),
    ...((c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? []),
    ...((c.get('userinfoSigningKeys') as SigningKey[] | undefined) ?? []),
  ];
}
