import { getJwaAlgorithm, extractAlgorithmParamsFromJwk } from './crypto-utils.js';
import type { SigningKey } from './signing-key.js';

/**
 * JWK（JSON Web Key）の型定義
 */
export interface Jwk {
  kty: string;
  use: string;
  alg: string;
  kid?: string;
  // RSA parameters
  n?: string;
  e?: string;
  // EC parameters
  crv?: string;
  x?: string;
  y?: string;
  // Private key parameters should never be present
  d?: undefined;
  p?: undefined;
  q?: undefined;
  dp?: undefined;
  dq?: undefined;
  qi?: undefined;
}

/**
 * JWK Set（JSON Web Key Set）の型定義
 */
export interface JwkSet {
  keys: Jwk[];
}

/**
 * exportJwks に渡す鍵の情報
 */
export interface JwksKeyEntry {
  publicKey: CryptoKey;
  keyId?: string;
}

/**
 * CryptoKeyから公開鍵のJWKを生成する
 *
 * 秘密鍵が渡された場合も公開部分のみをエクスポートする。
 * サポートするアルゴリズム:
 * - RSASSA-PKCS1-v1_5 (RS256/RS384/RS512)
 * - ECDSA (ES256/ES384/ES512)
 *
 * @param key CryptoKey（公開鍵または秘密鍵）
 * @param keyId オプションのキーID (kid)
 * @returns 公開鍵のJWK
 */
export async function exportPublicJwk(key: CryptoKey, keyId?: string): Promise<Jwk> {
  const alg = getJwaAlgorithm(key);

  const exported = await crypto.subtle.exportKey('jwk', key);

  const jwk: Jwk = {
    kty: exported.kty!,
    use: 'sig',
    alg,
  };

  if (keyId) {
    jwk.kid = keyId;
  }

  if (exported.kty === 'RSA') {
    jwk.n = exported.n;
    jwk.e = exported.e;
  } else if (exported.kty === 'EC') {
    jwk.crv = exported.crv;
    jwk.x = exported.x;
    jwk.y = exported.y;
  }

  return jwk;
}

/**
 * 複数のCryptoKeyからJWK Set（JWKS）を生成する
 *
 * JWKSエンドポイント（/.well-known/jwks.json）で公開する鍵セットを生成する。
 *
 * @param keys 鍵エントリの配列
 * @returns JWK Set
 */
export async function exportJwks(keys: JwksKeyEntry[]): Promise<JwkSet> {
  const jwks = await Promise.all(
    keys.map((entry) => exportPublicJwk(entry.publicKey, entry.keyId))
  );

  return { keys: jwks };
}

/**
 * SigningKey の配列から検証用の公開 JWK Set を生成する。
 *
 * SigningKey.publicJwk は SigningKeyProvider が返す素の JsonWebKey（kty/n/e など）
 * であり、`alg` / `use` / `kid` を含むとは限らない。一方 `validateIdTokenHint` は
 * kid 一致と alg 一致で鍵を選ぶため、ここで公開鍵を一度 import し直し、
 * `exportPublicJwk` で alg/use/kid 付きの正規化された JWK を導出する。
 *
 * `id_token_hint` 検証用の既定 jwksProvider が、OP 自身の ID Token 署名鍵セットから
 * JWKS を組み立てるために使う（OIDC Core 1.0 §3.1.2.2）。
 *
 * @param keys 公開部分を含む SigningKey の配列
 * @returns 公開鍵のみの JWK Set
 */
export async function signingKeysToJwkSet(keys: SigningKey[]): Promise<JwkSet> {
  const jwks = await Promise.all(
    keys.map(async (key) => {
      const algParams = extractAlgorithmParamsFromJwk(key.publicJwk);
      const publicKey = await crypto.subtle.importKey(
        'jwk',
        key.publicJwk,
        algParams,
        true,
        ['verify'],
      );
      return exportPublicJwk(publicKey, key.keyId);
    }),
  );

  return { keys: jwks };
}
