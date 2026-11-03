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
 * `CryptoKey` から公開鍵の JWK を作って返す。
 *
 * 返す JWK には、`kty`、`use`（常に `sig`）、`alg` と、鍵の種類ごとの公開鍵のパラメータ（RSA なら `n` と `e`、EC なら `crv`、`x`、`y`）だけを入れる。
 * 秘密鍵を渡しても、秘密鍵のパラメータ（`d` など）は含めない。
 * `kid` は、`keyId` が空でないときだけ入れる。
 *
 * `alg` は鍵のアルゴリズムから決める。
 * 対応するのは RSASSA-PKCS1-v1_5（RS256、RS384、RS512）と ECDSA（ES256、ES384、ES512）で、ほかのアルゴリズムの鍵には `Error` を投げる。
 * エクスポートできない鍵（`extractable` が `false` の鍵）を渡すと、`crypto.subtle.exportKey()` が失敗する。
 *
 * @param key 公開鍵または秘密鍵の `CryptoKey`
 * @param keyId `kid` に入れる鍵の ID（省略可）
 * @returns 公開鍵の JWK
 * @throws {Error} 鍵のアルゴリズムが RSASSA-PKCS1-v1_5 でも ECDSA でもないとき
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
 * 鍵の一覧から、公開鍵の JWK Set を作って返す。
 *
 * 各鍵を {@link exportPublicJwk} で JWK にし、渡された順に `keys` に並べる。
 * `keyId` を持つ鍵の JWK には `kid` が付く。
 * JWKS エンドポイント（`/.well-known/jwks.json`）が公開する JWK Set を作るのに使う。
 *
 * @param keys 公開鍵と鍵の ID の組の配列
 * @returns 公開鍵の JWK Set
 * @throws {Error} RSASSA-PKCS1-v1_5 と ECDSA 以外のアルゴリズムの鍵が含まれるとき
 */
export async function exportJwks(keys: JwksKeyEntry[]): Promise<JwkSet> {
  const jwks = await Promise.all(
    keys.map((entry) => exportPublicJwk(entry.publicKey, entry.keyId))
  );

  return { keys: jwks };
}

/**
 * 署名鍵から、検証用の公開鍵の JWK Set を作って返す。
 *
 * `SigningKey.publicJwk` は `SigningKeyProvider` が返したままの JWK（`kty`、`n`、`e` など）で、`alg`、`use`、`kid` を含むとは限らない。
 * 一方、`validateIdTokenHint()` は `kid` か `alg` の一致で鍵を選び、選んだ鍵の `alg` がヘッダーの `alg` と一致することも確かめる。
 * そこで、`publicJwk` を公開鍵としてインポートし直し、{@link exportPublicJwk} で `alg`、`use`、`kid`（`keyId` の値）を付けた JWK にして、渡された順に並べる。
 * 返す JWK には秘密鍵のパラメータを含めない。
 *
 * `publicJwk` から署名のアルゴリズムを決められない鍵には `Error` を投げる。
 * 決められないのは、RSA で `alg` が RS256、RS384、RS512 のどれでもない鍵（`alg` がない鍵を含む）、EC で `crv` が P-256、P-384、P-521 のどれでもない鍵、RSA でも EC でもない鍵である。
 *
 * `id_token_hint` の検証に使う既定の JWK Set を、OP 自身の ID トークンの署名鍵から作るのに使う。
 *
 * @spec OIDC Core 1.0 §3.1.2.2
 * @param keys 公開鍵の JWK を含む署名鍵の配列
 * @returns 公開鍵だけの JWK Set
 * @throws {Error} `publicJwk` から署名のアルゴリズムを決められないとき
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
