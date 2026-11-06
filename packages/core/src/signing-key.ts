import type { webcrypto } from 'node:crypto';
import { getJwaAlgorithm, rsaModulusBitLength } from './crypto-utils.js';

export interface SigningKey {
  privateKey: CryptoKey;
  publicJwk: webcrypto.JsonWebKey;
  keyId: string;
}

/**
 * Provider that loads the OP's signing keys from a secret store.
 *
 * `getSigningKeys()` returns every key the OP registers, and the array order
 * carries the meaning:
 *
 * - The FIRST key signs new tokens, so the array must not be empty.
 * - The keys after it are published (JWKS / Discovery) so the tokens they
 *   signed keep verifying — keys rotated out while their tokens are still in
 *   flight — or are picked by alg for a client that registered a different
 *   `*_signed_response_alg` (e.g. an ES256 key next to the RS256 one).
 *
 * To rotate, put the new key first and keep the previous one after it until
 * every token it signed has expired.
 */
export interface SigningKeyProvider {
  /**
   * 新しいトークンに署名する鍵を先頭にした配列を返す。
   *
   * 2 番目以降の鍵は、JWKS とディスカバリーで公開する鍵である。
   * ローテーションで署名に使わなくなった鍵で署名したトークンを有効期限まで検証できるようにするためと、別の `*_signed_response_alg` を登録したクライアント（RS256 の鍵の隣に置いた ES256 の鍵など）に `alg` で選んで署名するために使う。
   */
  getSigningKeys(): Promise<SigningKey[]>;
}

/**
 * `requestedAlg` に合う署名鍵のうち、先頭の鍵を返す。
 *
 * `requestedAlg` には、クライアントの `id_token_signed_response_alg` など、`*_signed_response_alg` のメタデータの値を渡す。
 * `undefined` なら、OpenID Connect の既定値の `RS256` を使う（OIDC Dynamic Client Registration 1.0 §2）。
 * 鍵の `alg` は秘密鍵のアルゴリズムから求め、求められない鍵（アルゴリズムの情報を持たないスタブの鍵など）は飛ばす。
 *
 * 同じ `alg` の鍵が複数あるとき（ローテーションの途中など）は、配列の先頭に近い鍵を選ぶ。
 * 鍵の配列は、新しいトークンに署名する鍵が先頭に来るように並べてあるためである（{@link SigningKeyProvider}）。
 *
 * 一致する鍵がなければ `Error` を投げ、呼び出し側はこれをサーバーの設定の誤りとして扱う。
 * 署名できない `alg` を公開したまま進めると、クライアントが検証できない ID トークンを発行することになるためである。
 *
 * @spec OIDC Dynamic Client Registration 1.0 §2
 * @throws {Error} `keys` が空のとき、または `alg` が一致する鍵がないとき
 */
export function selectSigningKeyByAlg(
  keys: readonly SigningKey[],
  requestedAlg: string | undefined,
): SigningKey {
  if (keys.length === 0) {
    throw new Error('No signing keys available');
  }
  const alg = requestedAlg ?? 'RS256';
  for (const key of keys) {
    try {
      if (getJwaAlgorithm(key.privateKey) === alg) {
        return key;
      }
    } catch {
      // `alg` を求められない鍵（アルゴリズムの情報を持たないスタブの鍵など）は飛ばす。
    }
  }
  throw new Error(`No signing key registered for alg "${alg}"`);
}

/**
 * RS256 の鍵が一つもなければ `Error` を投げる。
 *
 * RS256 の鍵とは、SHA-256 を使う RSASSA-PKCS1-v1_5 の鍵である。
 * OP は RS256 に対応しなければならない（MUST、OIDC Core 1.0 §15.1）。
 * この要求は鍵の集合に対するもので、RS256 で署名できれば、ES256 などを好むクライアントのためにほかの鍵を加えてもよい。
 * アルゴリズムを求められない鍵は、RS256 の鍵として数えない。
 *
 * @spec OIDC Core 1.0 §15.1
 * @throws {Error} RS256（SHA-256 を使う RSASSA-PKCS1-v1_5）の鍵がないとき
 */
export function assertHasRs256Key(keys: CryptoKey[]): void {
  for (const key of keys) {
    try {
      if (getJwaAlgorithm(key) === 'RS256') {
        return;
      }
    } catch {
      // 対応していないアルゴリズムの鍵は候補にせず、次の鍵を確かめる。
    }
  }
  throw new Error(
    'OIDC Core 1.0 §15.1 violation: at least one RS256 (RSASSA-PKCS1-v1_5 with SHA-256) key is required',
  );
}

/**
 * `kid` が空か重複する鍵があれば `Error` を投げる。
 *
 * 鍵を二つ以上公開するときは、すべての鍵が空でない `keyId` を持ち、`keyId` が互いに異なっていなければならない。
 * `kid` は JWK Set の複数の鍵から使う鍵を選ぶための値であり（RFC 7517 §4.5）、鍵をローテーションするときや複数の鍵を使うときは `kid` で鍵を選ぶことが想定されている（OIDC Core 1.0 §10.1）。
 * `kid` が空だったり重複していたりすると、RP は検証に使う鍵を一つに決められず、ID トークンの検証が気付かれないまま失敗するおそれがある。
 *
 * 鍵が一つだけのときは何も確かめない。
 * 一つの鍵は `kid` がなくても一意に決まり、OIDC Core 1.0 §10.1 も JWK Set が複数の鍵を持つときにだけ `kid` を求めているためである。
 *
 * @spec RFC 7517 §4.5
 * @spec OIDC Core 1.0 §10.1
 * @throws {Error} 鍵が複数あり、空の `keyId` か重複した `keyId` を持つ鍵があるとき
 */
export function assertKidStrategyConsistent(keys: readonly SigningKey[]): void {
  if (keys.length <= 1) return; // 鍵が一つなら、`kid` がなくても一意に決まる。
  const seen = new Set<string>();
  for (const key of keys) {
    if (!key.keyId) {
      throw new Error(
        'Multiple signing keys are published but a key has an empty kid (RFC 7517 §4.5)',
      );
    }
    if (seen.has(key.keyId)) {
      throw new Error(`Duplicate kid in signing key set: ${key.keyId} (RFC 7517 §4.5)`);
    }
    seen.add(key.keyId);
  }
}

/**
 * Minimum cryptographic strength a signing key must meet to be accepted.
 *
 * Defaults follow NIST SP 800-131A Rev.2 (RSA >= 2048-bit, 112-bit security)
 * and the NIST-approved curves for ECDSA. FAPI profiles may tighten these by
 * passing a stricter policy.
 */
export interface KeyStrengthPolicy {
  /** Minimum RSA modulus bit length. Default: 2048 (NIST SP 800-131A Rev.2). */
  minRsaModulusBits?: number;
  /** Allowed EC curves. Default: P-256 / P-384 / P-521. */
  allowedCurves?: readonly string[];
}

// NIST SP 800-131A Rev.2: RSA 1024-bit is disallowed; 2048-bit (112-bit
// security strength) is the minimum for use beyond 2030.
const DEFAULT_MIN_RSA_MODULUS_BITS = 2048;
// NIST-approved curves for ECDSA signing (P-256 ~ 128-bit security and above).
const DEFAULT_ALLOWED_CURVES: readonly string[] = ['P-256', 'P-384', 'P-521'];

/**
 * 強度が足りない署名鍵があれば `Error` を投げる。
 *
 * 鍵を順に確かめ、最初に見つかった弱い鍵で `Error` を投げる。
 * 鍵の種類ごとの条件は次のとおりである:
 * - RSA の鍵は、公開鍵の JWK の `n` から求めたモジュラスのビット長が `minRsaModulusBits`（既定値は 2048）以上でなければならず、`n` がない鍵も拒否する。
 * - EC の鍵は、曲線（`crv`）が `allowedCurves`（既定値は P-256、P-384、P-521）のどれかでなければならない。
 * - RSA と EC 以外の種類の鍵は、対応していない鍵として拒否する。
 *
 * 署名を信頼できるかどうかは、署名した鍵の強度で決まる（RFC 8725 §3.5、§3.3）。
 * Web Crypto の `importKey()` は 512 ビットや 1024 ビットの RSA の鍵も受け付けるので、設定を誤った OP が、検証は通るのに偽造できる ID トークンを配布するおそれがある。
 * そこで起動時に {@link assertHasRs256Key} と一緒に呼び、弱い鍵がトークンに署名する前に拒否する。
 *
 * エラーのメッセージには問題の鍵の `keyId` を含め、運用者が鍵を特定できるようにする。
 * このメッセージはログと起動時のためのもので、クライアントに返す `error_description` には含めない。
 *
 * @spec RFC 8725 §3.5
 * @spec RFC 8725 §3.3
 * @throws {Error} 強度が足りない鍵、`n` がない RSA の鍵、許されていない曲線の EC の鍵、RSA でも EC でもない鍵があるとき
 */
export function assertKeyStrength(
  keys: readonly SigningKey[],
  policy?: KeyStrengthPolicy,
): void {
  const minRsaModulusBits = policy?.minRsaModulusBits ?? DEFAULT_MIN_RSA_MODULUS_BITS;
  const allowedCurves = policy?.allowedCurves ?? DEFAULT_ALLOWED_CURVES;

  for (const key of keys) {
    const jwk = key.publicJwk;

    if (jwk.kty === 'RSA') {
      if (!jwk.n) {
        throw new Error(
          `Signing key "${key.keyId}" is an RSA key but its public JWK has no modulus (n)`,
        );
      }
      const bits = rsaModulusBitLength(jwk.n);
      if (bits < minRsaModulusBits) {
        throw new Error(
          `Signing key "${key.keyId}" has a ${bits}-bit RSA modulus; minimum allowed is ${minRsaModulusBits} bits (NIST SP 800-131A Rev.2)`,
        );
      }
      continue;
    }

    if (jwk.kty === 'EC') {
      if (!jwk.crv || !allowedCurves.includes(jwk.crv)) {
        throw new Error(
          `Signing key "${key.keyId}" uses unsupported EC curve "${jwk.crv ?? '(missing)'}"; allowed curves: ${allowedCurves.join(', ')}`,
        );
      }
      continue;
    }

    throw new Error(
      `Signing key "${key.keyId}" uses unsupported key type "${jwk.kty ?? '(missing)'}"`,
    );
  }
}

/**
 * {@link createCachedSigningKeyProvider} が返す、キャッシュを捨てられる署名鍵のプロバイダ。
 */
export interface CachedSigningKeyProvider extends SigningKeyProvider {
  /**
   * キャッシュした鍵を捨てる。次の `getSigningKeys()` は `base.getSigningKeys()` を呼んで読み直す。
   *
   * 鍵をローテーションしたとき（新しい鍵を先頭に足し、古い鍵を後ろに残したとき）に呼ぶと、TTL を待たずに、次のリクエストから新しい鍵で署名し、JWKS に公開する（OIDC Core 1.0 §10.1.1）。
   */
  invalidate(): void;
}

/**
 * `base` の署名鍵をキャッシュするプロバイダを返す。
 *
 * 返すプロバイダの `getSigningKeys()` は、キャッシュがないとき、またはキャッシュしてから `ttlMs` ミリ秒を超えたときだけ `base.getSigningKeys()` を呼び、結果をキャッシュしてから返す。
 * それ以外のときは、キャッシュした鍵を返す。
 * `base.getSigningKeys()` が失敗したときは、キャッシュを更新せずにそのエラーを投げる。
 * `invalidate()` はキャッシュを捨て、次の `getSigningKeys()` に `base` から読み直させる。
 *
 * リクエストのたびにシークレットストアを読みに行くのを避けつつ、ローテーションした鍵を `ttlMs` ミリ秒後には読み込める。
 * ローテーションをすぐに反映するときは、鍵を変えた後で `invalidate()` を呼ぶ。
 *
 * @spec OIDC Core 1.0 §10.1.1
 */
export function createCachedSigningKeyProvider(
  base: SigningKeyProvider,
  ttlMs: number,
): CachedSigningKeyProvider {
  let cache: { keys: SigningKey[]; expiresAt: number } | null = null;

  return {
    async getSigningKeys(): Promise<SigningKey[]> {
      if (!cache || Date.now() > cache.expiresAt) {
        const keys = await base.getSigningKeys();
        cache = { keys, expiresAt: Date.now() + ttlMs };
      }
      return cache.keys;
    },
    invalidate(): void {
      cache = null;
    },
  };
}
