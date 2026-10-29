/**
 * dynamic-client-registration テスト専用フィクスチャ。
 *
 * tsconfig の exclude 対象なので dist へは出ない（公開 package に載らない）。
 * jwks メタデータの検査に使う公開鍵の生成を Web Crypto API だけで行い、
 * edge-runtime 環境のテストでそのまま動くようにしている。
 */
import type { Jwk, JwkSet } from '@maronn-openid-connect/core';

export interface TestSigningKey {
  privateKey: CryptoKey;
  jwk: Jwk;
  jwks: JwkSet;
}

/** RS256 の鍵ペアを生成し、秘密鍵と公開 JWK セットを返す。 */
export async function generateTestRs256Key(keyId: string): Promise<TestSigningKey> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  return exportTestKey(keyPair, keyId, 'RS256');
}

async function exportTestKey(keyPair: CryptoKeyPair, keyId: string, alg: string): Promise<TestSigningKey> {
  const exported = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as Record<string, unknown>;
  const jwk = {
    kty: exported['kty'],
    ...(exported['kty'] === 'RSA' ? { n: exported['n'], e: exported['e'] } : { crv: exported['crv'], x: exported['x'], y: exported['y'] }),
    alg,
    use: 'sig',
    kid: keyId,
  } as Jwk;
  return { privateKey: keyPair.privateKey, jwk, jwks: { keys: [jwk] } };
}
