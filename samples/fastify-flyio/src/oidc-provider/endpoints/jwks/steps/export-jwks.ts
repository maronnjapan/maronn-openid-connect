import {
  type SigningKey,
  exportJwks,
  extractAlgorithmParamsFromJwk,
  type JwkSet,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'export-jwks',
  endpoint: 'jwks',
  kind: 'transform',
  label: '公開鍵を JWK Set にまとめる',
  spec: 'RFC 7517 §5',
  function: 'buildJwksDocument',
  consumes: ['keys'],
  produces: ['jwks'],
  removable: false,
});

/**
 * 署名鍵の公開鍵を JWK Set にして返す。
 *
 * `kid` が同じ鍵は、最初の 1 つだけを含める。
 * `kid` のない鍵も 1 つの `kid` として扱い、最初の 1 つ（鍵の集合は新しい鍵から並ぶので、最も新しい鍵）だけを含める。
 * 各鍵の公開 JWK を検証用の鍵として読み込み直し、`use`、`alg`、`kid` を付けた JWK にする（core の `exportJwks()`）。
 *
 * @throws {Error} 鍵が 1 つもないとき（サーバーの設定の誤り）。
 * @spec RFC 7517 §5
 */
export async function buildJwksDocument(keys: SigningKey[]): Promise<JwkSet> {
  if (keys.length === 0) {
    throw new Error('No signing key is registered');
  }

  // 同じ `kid` の鍵は、最初に現れたものだけを含める。
  // ID トークン用と UserInfo 用の鍵のプロバイダは、既定では汎用のプロバイダと同じ鍵を返すためである。
  // `kid` のない鍵も同じように、最初の 1 つ（最も新しい鍵）だけを含める。
  const seenKids = new Set<string>();
  const entries: { publicKey: CryptoKey; keyId?: string }[] = [];
  for (const key of keys) {
    if (seenKids.has(key.keyId)) continue;
    seenKids.add(key.keyId);
    const jwk = key.publicJwk as JsonWebKey;
    const algParams = extractAlgorithmParamsFromJwk(jwk);
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      algParams,
      true,
      ['verify'],
    );
    entries.push({ publicKey, keyId: key.keyId });
  }

  return exportJwks(entries);
}
