import type { webcrypto } from 'node:crypto';

/**
 * 秘密鍵を用いてデータに署名を行う
 * @param data 署名対象のデータ
 * @param privateKey 秘密鍵（CryptoKey）
 * @returns 署名されたデータ（Base64URL形式）
 */
export async function sign(data: string, privateKey: CryptoKey): Promise<string> {
  const dataBuffer = stringToArrayBuffer(data);
  const algorithm = privateKey.algorithm;

  let signParams: webcrypto.AlgorithmIdentifier | webcrypto.EcdsaParams;

  if (algorithm.name === 'RSASSA-PKCS1-v1_5' && 'hash' in algorithm) {
    signParams = { name: 'RSASSA-PKCS1-v1_5' };
  } else if (algorithm.name === 'ECDSA' && 'namedCurve' in algorithm) {
    const namedCurve = (algorithm as webcrypto.EcKeyAlgorithm).namedCurve;
    // Choose hash based on curve
    const hash = namedCurve === 'P-256' ? 'SHA-256' : namedCurve === 'P-384' ? 'SHA-384' : 'SHA-512';
    signParams = { name: 'ECDSA', hash };
  } else {
    throw new Error(`Unsupported algorithm: ${algorithm.name}`);
  }

  const signature = await crypto.subtle.sign(signParams, privateKey, dataBuffer);
  return arrayBufferToBase64Url(signature);
}

/**
 * 公開鍵を用いて署名を検証する
 * @param data 検証対象のデータ
 * @param signature 署名（Base64URL形式）
 * @param publicKey 公開鍵（CryptoKey）
 * @returns 署名が有効かどうか
 */
export async function verify(data: string, signature: string, publicKey: CryptoKey): Promise<boolean> {
  const dataBuffer = stringToArrayBuffer(data);
  const signatureBuffer = base64UrlToArrayBuffer(signature);
  const algorithm = publicKey.algorithm;

  let verifyParams: webcrypto.AlgorithmIdentifier | webcrypto.EcdsaParams;

  if (algorithm.name === 'RSASSA-PKCS1-v1_5' && 'hash' in algorithm) {
    verifyParams = { name: 'RSASSA-PKCS1-v1_5' };
  } else if (algorithm.name === 'ECDSA' && 'namedCurve' in algorithm) {
    const namedCurve = (algorithm as webcrypto.EcKeyAlgorithm).namedCurve;
    // Choose hash based on curve
    const hash = namedCurve === 'P-256' ? 'SHA-256' : namedCurve === 'P-384' ? 'SHA-384' : 'SHA-512';
    verifyParams = { name: 'ECDSA', hash };
  } else {
    throw new Error(`Unsupported algorithm: ${algorithm.name}`);
  }

  return crypto.subtle.verify(verifyParams, publicKey, signatureBuffer, dataBuffer);
}

/**
 * 暗号学的に安全なランダム文字列を生成する（Base64URLエンコード）
 * CSPRNGを使用し、指定バイト長のランダムバイト列をBase64URLエンコードして返す
 *
 * @param byteLength ランダムバイトの長さ（例: 32 = 256ビット）
 * @returns Base64URLエンコードされたランダム文字列
 */
export function generateRandomString(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return arrayBufferToBase64Url(bytes.buffer);
}

/**
 * 2つの文字列を constant-time で比較する。
 *
 * OAuth 2.1 §7.4.1 / RFC 6749 §10.10:
 * client_secret などの credential 比較を通常の `===` で行うと、
 * 先頭から一致した長さに応じて応答時間が変わるため timing attack で
 * 1 文字ずつ secret を漸進的に推測される恐れがある。
 *
 * Web Crypto API には timingSafeEqual が無いので、ランダム鍵で
 * HMAC-SHA256 をかけ、固定長ダイジェスト同士を XOR ベースで比較する。
 * HMAC 鍵はこの呼び出し限りのもの（extractable=false / セッション内生成）で、
 * 文字列長や内容を観測しても元の値を復元できない。
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(a)),
    crypto.subtle.sign('HMAC', key, encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(sigA);
  const bytesB = new Uint8Array(sigB);
  if (bytesA.length !== bytesB.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i]! ^ bytesB[i]!;
  }
  return diff === 0;
}

/**
 * SHA-256を用いてデータをハッシュ化する
 * @param data ハッシュ化対象のデータ
 * @returns ハッシュ値（Base64URL形式）
 */
export async function sha256(data: string): Promise<string> {
  const buffer = stringToArrayBuffer(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return arrayBufferToBase64Url(hashBuffer);
}

/**
 * ArrayBufferをBase64URL形式の文字列に変換する
 * @param buffer 変換対象のArrayBuffer
 * @returns Base64URL形式の文字列
 */
export function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];

    // 型ガード
    if (byte === undefined) {
      throw new Error('Unexpected undefined byte in ArrayBuffer');
    }

    binary += String.fromCharCode(byte);
  }
  const base64 = btoa(binary);
  // Convert Base64 to Base64URL: replace + with -, / with _, remove padding =
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Base64URL形式の文字列をArrayBufferに変換する
 * @param base64url Base64URL形式の文字列
 * @returns ArrayBuffer
 */
export function base64UrlToArrayBuffer(base64url: string): ArrayBuffer {
  // Convert Base64URL to Base64: replace - with +, _ with /
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding if necessary
  const paddedBase64 = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(paddedBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    // charCodeAt always returns a number for an in-range index, so no undefined guard.
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// RFC 7515 §2 / Appendix C: base64url uses the URL-safe alphabet with no padding.
// A canonical encoding never contains '+', '/', '=' or whitespace, and its length
// mod 4 is never 1 (an impossible remainder for base64). `atob` silently tolerates
// some of these, so strict decoding is used on security-sensitive JWS segments to
// refuse non-canonical input (RFC 8725 §3.11 strict parsing).
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

/**
 * Base64URL 文字列を strict に検証してから ArrayBuffer に変換する。
 * base64url アルファベット外の文字（`+` `/` `=` 空白など）や不正長（`len % 4 === 1`）を拒否する。
 * JWS の header/payload など、改ざん耐性が必要なデコード経路で使う。
 */
export function base64UrlToArrayBufferStrict(base64url: string): ArrayBuffer {
  if (!BASE64URL_PATTERN.test(base64url)) {
    throw new Error('Invalid base64url: contains characters outside the base64url alphabet');
  }
  if (base64url.length % 4 === 1) {
    throw new Error('Invalid base64url: malformed length');
  }
  return base64UrlToArrayBuffer(base64url);
}

/**
 * 文字列をArrayBufferに変換する
 * @param str 変換対象の文字列
 * @returns ArrayBuffer
 */
export function stringToArrayBuffer(str: string): ArrayBuffer {
  return new TextEncoder().encode(str).buffer;
}

/**
 * JWK の `n`（RSA モジュラス）からモジュラスのビット長を求める純粋関数。
 *
 * RFC 7518 §6.3.1.1: JWK の `n` は base64url エンコードされた RSA モジュラス。
 * base64url をデコードしたバイト列の先頭ゼロパディングを取り除いた長さ × 8 が
 * 実効ビット長になる（ASN.1/DER は最上位ビットが立つ場合に 0x00 を前置するため、
 * 先頭ゼロを数えるとビット長を過大評価してしまう）。
 *
 * 鍵強度ポリシー（`assertKeyStrength`）が RSA 鍵長の下限を判定するために使う。
 * Web 標準 API のみで実装し、外部依存を増やさない。
 *
 * @param jwkN JWK の `n`（base64url 文字列）
 * @returns モジュラスのビット長（全ゼロのときは 0）
 */
export function rsaModulusBitLength(jwkN: string): number {
  const bytes = new Uint8Array(base64UrlToArrayBuffer(jwkN));
  let i = 0;
  // Skip leading zero padding bytes so the bit length is not overestimated.
  while (i < bytes.length && bytes[i] === 0) {
    i++;
  }
  return (bytes.length - i) * 8;
}

/**
 * JWK（JSON Web Key）形式の文字列をCryptoKeyに変換する
 * @param jwkString JWK形式の文字列
 * @param algorithm アルゴリズム指定（デフォルト: RS256用 RSASSA-PKCS1-v1_5 with SHA-256）
 *                  サポートするアルゴリズム（JWA名称 = 暗号方式）:
 *                  - RS256/RS384/RS512 = RSASSA-PKCS1-v1_5 with SHA-256/384/512
 *                    ※ OpenID Connect Core 1.0でRS256はデフォルトアルゴリズム（SHOULD）
 *                  - ES256/ES384/ES512 = ECDSA with P-256/P-384/P-521 and SHA-256/384/512【推奨】
 *                    ※ 楕円曲線暗号による高速かつ安全な署名方式
 * @param extractable キーをエクスポート可能にするか（デフォルト: true）
 * @param keyUsages キーの用途（デフォルト: ['sign'] for private, ['verify'] for public）
 * @returns CryptoKey
 */
async function importKeyFromJwk(
  jwkString: string,
  algorithm: webcrypto.RsaHashedImportParams | webcrypto.EcKeyImportParams = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
  },
  extractable = true,
  keyUsages?: webcrypto.KeyUsage[]
): Promise<CryptoKey> {
  const jwk = JSON.parse(jwkString) as webcrypto.JsonWebKey;

  // Determine if this is a private or public key
  const isPrivateKey = jwk.kty === 'RSA' ? 'd' in jwk : 'd' in jwk;

  // Set default key usages based on key type
  const usages = keyUsages ?? (isPrivateKey ? ['sign'] : ['verify']);

  return crypto.subtle.importKey('jwk', jwk, algorithm, extractable, usages);
}

/**
 * JWK（JSON Web Key）形式の秘密鍵の文字列をCryptoKeyに変換する
 * @param jwkString JWK形式の文字列
 * @param algorithm アルゴリズム指定（デフォルト: RS256用 RSASSA-PKCS1-v1_5 with SHA-256）
 *                  サポートするアルゴリズム（JWA名称 = 暗号方式）:
 *                  - RS256/RS384/RS512 = RSASSA-PKCS1-v1_5 with SHA-256/384/512
 *                    ※ OpenID Connect Core 1.0でRS256はデフォルトアルゴリズム（SHOULD）
 *                  - ES256/ES384/ES512 = ECDSA with P-256/P-384/P-521 and SHA-256/384/512【推奨】
 *                    ※ 楕円曲線暗号による高速かつ安全な署名方式
 * @param extractable キーをエクスポート可能にするか（デフォルト: true）
 * @param keyUsages キーの用途（デフォルト: ['sign'] for private, ['verify'] for public）
 * @returns CryptoKey
 */
export async function importPrivateKeyFromJwk(
  jwkString: string,
  algorithm: webcrypto.RsaHashedImportParams | webcrypto.EcKeyImportParams = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
  },
  keyUsages?: webcrypto.KeyUsage[]
): Promise<CryptoKey> {

  return importKeyFromJwk(jwkString, algorithm, false, keyUsages);
}


/**
 * JWK（JSON Web Key）形式の公開鍵の文字列をCryptoKeyに変換する
 * @param jwkString JWK形式の文字列
 * @param algorithm アルゴリズム指定（デフォルト: RS256用 RSASSA-PKCS1-v1_5 with SHA-256）
 *                  サポートするアルゴリズム（JWA名称 = 暗号方式）:
 *                  - RS256/RS384/RS512 = RSASSA-PKCS1-v1_5 with SHA-256/384/512
 *                    ※ OpenID Connect Core 1.0でRS256はデフォルトアルゴリズム（SHOULD）
 *                  - ES256/ES384/ES512 = ECDSA with P-256/P-384/P-521 and SHA-256/384/512【推奨】
 *                    ※ 楕円曲線暗号による高速かつ安全な署名方式
 * @param extractable キーをエクスポート可能にするか（デフォルト: true）
 * @param keyUsages キーの用途（デフォルト: ['sign'] for private, ['verify'] for public）
 * @returns CryptoKey
 */
export async function importPublicKeyFromJwk(
  jwkString: string,
  algorithm: webcrypto.RsaHashedImportParams | webcrypto.EcKeyImportParams = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
  },
  keyUsages?: webcrypto.KeyUsage[]
): Promise<CryptoKey> {
  return importKeyFromJwk(jwkString, algorithm, true, keyUsages);
}



/**
 * CryptoKeyからアルゴリズムパラメータを導出する
 * サポートするアルゴリズム（JWA名称 = 暗号方式）:
 * - RS256/RS384/RS512 = RSASSA-PKCS1-v1_5 with SHA-256/384/512
 *   ※ OpenID Connect Core 1.0でRS256はデフォルトアルゴリズム（SHOULD）
 * - ES256/ES384/ES512 = ECDSA with P-256/P-384/P-521【推奨】
 *   ※ 楕円曲線暗号による高速かつ安全な署名方式
 * @param key CryptoKey
 * @returns RsaHashedImportParams | EcKeyImportParams
 * @throws サポートされていないアルゴリズムの場合
 */
export function extractAlgorithmParams(key: CryptoKey): webcrypto.RsaHashedImportParams | webcrypto.EcKeyImportParams {
  const algorithm = key.algorithm;

  if (algorithm.name === 'RSASSA-PKCS1-v1_5' && 'hash' in algorithm) {
    const rsaAlgo = algorithm as webcrypto.RsaHashedKeyAlgorithm;
    const hashName = rsaAlgo.hash.name;

    // Reject weak hash algorithms
    if (hashName === 'SHA-1') {
      throw new Error('Unsupported hash algorithm: SHA-1');
    }

    return {
      name: algorithm.name,
      hash: hashName as 'SHA-256' | 'SHA-384' | 'SHA-512',
    };
  }

  if (algorithm.name === 'ECDSA' && 'namedCurve' in algorithm) {
    const ecAlgo = algorithm as webcrypto.EcKeyAlgorithm;
    return {
      name: 'ECDSA',
      namedCurve: ecAlgo.namedCurve as 'P-256' | 'P-384' | 'P-521',
    };
  }

  throw new Error(`Unsupported algorithm: ${algorithm.name}`);
}


/**
 * JWK の kty / alg / crv から WebCrypto importKey 用のアルゴリズムパラメータを構築する。
 *
 * RS256/RS384/RS512 をハードコードしている JWKS ルートが ES256 等の鍵を扱えるようにするため、
 * JWK のフィールドから動的に解決する。
 *
 * サポートするアルゴリズム:
 * - kty=RSA + alg=RS256/RS384/RS512 = RSASSA-PKCS1-v1_5 with SHA-256/384/512
 * - kty=EC  + crv=P-256/P-384/P-521 = ECDSA with P-256/P-384/P-521
 */
export function extractAlgorithmParamsFromJwk(
  jwk: webcrypto.JsonWebKey
): webcrypto.RsaHashedImportParams | webcrypto.EcKeyImportParams {
  if (jwk.kty === 'RSA') {
    const alg = jwk.alg;
    const hash =
      alg === 'RS256'
        ? 'SHA-256'
        : alg === 'RS384'
          ? 'SHA-384'
          : alg === 'RS512'
            ? 'SHA-512'
            : null;
    if (!hash) {
      throw new Error(`Unsupported RSA alg: ${alg ?? '(missing)'}`);
    }
    return { name: 'RSASSA-PKCS1-v1_5', hash };
  }

  if (jwk.kty === 'EC') {
    const crv = jwk.crv;
    if (crv !== 'P-256' && crv !== 'P-384' && crv !== 'P-521') {
      throw new Error(`Unsupported EC curve: ${crv ?? '(missing)'}`);
    }
    return { name: 'ECDSA', namedCurve: crv };
  }

  throw new Error(`Unsupported kty: ${jwk.kty ?? '(missing)'}`);
}

/** RS256 / RS384 / RS512 のハッシュ（RFC 7518 §3.3）。ほかの alg は undefined。 */
function rsaSigningHashOf(alg: string): 'SHA-256' | 'SHA-384' | 'SHA-512' | undefined {
  switch (alg) {
    case 'RS256':
      return 'SHA-256';
    case 'RS384':
      return 'SHA-384';
    case 'RS512':
      return 'SHA-512';
    default:
      return undefined;
  }
}

/** ES256 / ES384 / ES512 の曲線（RFC 7518 §3.4）。ほかの alg は undefined。 */
function ecSigningCurveOf(alg: string): 'P-256' | 'P-384' | 'P-521' | undefined {
  switch (alg) {
    case 'ES256':
      return 'P-256';
    case 'ES384':
      return 'P-384';
    case 'ES512':
      return 'P-521';
    default:
      return undefined;
  }
}

/** 曲線で署名する ES 系の alg（RFC 7518 §3.4）。ほかの曲線は undefined。 */
function ecSigningAlgOfCurve(crv: string | undefined): 'ES256' | 'ES384' | 'ES512' | undefined {
  switch (crv) {
    case 'P-256':
      return 'ES256';
    case 'P-384':
      return 'ES384';
    case 'P-521':
      return 'ES512';
    default:
      return undefined;
  }
}

/**
 * RFC 7518 §3.3: RS256 / RS384 / RS512 には 2048 ビット以上の鍵を使わなければならない（MUST）。
 */
const MIN_RSA_VERIFICATION_MODULUS_BITS = 2048;

/**
 * JWK が使える唯一の JWS 署名アルゴリズムを決める純粋関数。
 *
 * RFC 8725 §3.1: 各鍵はちょうど 1 つのアルゴリズムで使い、それを処理時に確かめなければならない
 * （MUST）。署名を検証する側は、JOSE ヘッダーの `alg` がこの関数の返す値と一致する鍵だけを使う。
 *
 * - RSA 鍵: `alg` が RS256 / RS384 / RS512 ならその値。`alg` が無ければ RS256
 *   （`alg` は OPTIONAL（RFC 7517 §4.4）で、省く JWK Set が多いため。DCR の
 *   `validateJwks()` の正規化と同じ規則）。それ以外の `alg`（PS256 など）は undefined
 * - EC 鍵: `crv` が P-256 / P-384 / P-521 ならそれぞれ ES256 / ES384 / ES512（RFC 7518 §3.4）。
 *   `alg` があって `crv` と食い違えば undefined
 * - ほかの鍵（`oct`、`OKP` など）は undefined
 *
 * @param jwk 公開鍵の JWK
 * @returns その鍵で検証してよい alg。決められなければ undefined
 */
export function resolveJwkSigningAlg(jwk: webcrypto.JsonWebKey): string | undefined {
  if (jwk.kty === 'RSA') {
    if (jwk.alg === undefined) {
      return 'RS256';
    }
    return rsaSigningHashOf(jwk.alg) === undefined ? undefined : jwk.alg;
  }
  if (jwk.kty === 'EC') {
    const curveAlg = ecSigningAlgOfCurve(jwk.crv);
    if (curveAlg === undefined || (jwk.alg !== undefined && jwk.alg !== curveAlg)) {
      return undefined;
    }
    return curveAlg;
  }
  return undefined;
}

/**
 * JWS の `alg` のとおりに、公開鍵の JWK を署名検証用の CryptoKey として import する。
 *
 * import の引数は JWK ではなく `alg` から組み立てる。RS 系は RSASSA-PKCS1-v1_5 と対応する
 * ハッシュ（RFC 7518 §3.3）、ES 系は対応する曲線の ECDSA（RFC 7518 §3.4）である。`verify()` は
 * EC の曲線からハッシュを選ぶので、曲線を alg に固定すれば検証のアルゴリズムは `alg` と一致する。
 *
 * - {@link resolveJwkSigningAlg} が `alg` と同じ値を返さない鍵（kty / crv / alg の食い違い、
 *   alg の無い RSA 鍵を RS384 で使う場合など）は拒否する（RFC 8725 §3.1）
 * - 2048 ビット未満の RSA 鍵は拒否する（RFC 7518 §3.3 MUST）
 * - import するのは公開鍵のメンバー（RSA は kty / n / e、EC は kty / crv / x / y）だけで、
 *   `use`、`key_ops`、秘密鍵のメンバーは渡さない
 *
 * @param jwk 公開鍵の JWK
 * @param alg 検証する JWS の JOSE ヘッダーの `alg`
 * @returns 検証にだけ使える、エクスポートできない公開鍵
 * @throws alg と鍵が対応しない場合、RSA 鍵が短い場合、WebCrypto が鍵を受け付けない場合
 */
export async function importJwkForJwsVerification(
  jwk: webcrypto.JsonWebKey,
  alg: string,
): Promise<CryptoKey> {
  if (resolveJwkSigningAlg(jwk) !== alg) {
    throw new Error(`The JWK cannot be used with ${alg}`);
  }

  const hash = rsaSigningHashOf(alg);
  if (hash !== undefined) {
    if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
      throw new Error('The RSA JWK has no n or e');
    }
    if (rsaModulusBitLength(jwk.n) < MIN_RSA_VERIFICATION_MODULUS_BITS) {
      throw new Error('RSA keys shorter than 2048 bits are not accepted (RFC 7518 §3.3)');
    }
    return crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e },
      { name: 'RSASSA-PKCS1-v1_5', hash },
      false,
      ['verify'],
    );
  }

  const namedCurve = ecSigningCurveOf(alg);
  if (namedCurve !== undefined) {
    if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
      throw new Error('The EC JWK has no x or y');
    }
    return crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: namedCurve, x: jwk.x, y: jwk.y },
      { name: 'ECDSA', namedCurve },
      false,
      ['verify'],
    );
  }

  // resolveJwkSigningAlg() returns RS* / ES* only, so this is unreachable.
  throw new Error(`The JWK cannot be used with ${alg}`);
}

/**
 * JWA 署名アルゴリズム名から、ハッシュクレーム (at_hash / c_hash) で使うハッシュ関数名を導出する。
 *
 * OIDC Core 1.0 §3.1.3.6: at_hash のハッシュ関数は「ID Token の JOSE Header `alg` で
 * 使われるハッシュ関数」と一致させる必要がある（RS256/ES256/PS256→SHA-256,
 * …384→SHA-384, …512→SHA-512）。RFC 7518 §3.1 の RSxxx / ESxxx / PSxxx 命名規則に従い、
 * 末尾 3 桁のビット長でハッシュ関数を判別する。
 *
 * @param alg JWA 署名アルゴリズム名（例: RS256, ES384, RS512）
 * @returns 対応する Web Crypto のダイジェストアルゴリズム名
 * @throws サポートされていない alg の場合
 */
export function jwaToHashName(alg: string): 'SHA-256' | 'SHA-384' | 'SHA-512' {
  if (alg.endsWith('256')) return 'SHA-256';
  if (alg.endsWith('384')) return 'SHA-384';
  if (alg.endsWith('512')) return 'SHA-512';
  throw new Error(`Unsupported alg for hash claim: ${alg}`);
}

/**
 * アルゴリズム名をJWA形式に変換する
 */
export function getJwaAlgorithm(key: CryptoKey): string {
  const algorithm = key.algorithm;

  if (algorithm.name === 'RSASSA-PKCS1-v1_5' && 'hash' in algorithm) {
    const hash = (algorithm as webcrypto.RsaHashedKeyAlgorithm).hash.name;
    return hash === 'SHA-256' ? 'RS256' : hash === 'SHA-384' ? 'RS384' : 'RS512';
  }

  if (algorithm.name === 'ECDSA' && 'namedCurve' in algorithm) {
    const curve = (algorithm as webcrypto.EcKeyAlgorithm).namedCurve;
    return curve === 'P-256' ? 'ES256' : curve === 'P-384' ? 'ES384' : 'ES512';
  }

  throw new Error(`Unsupported algorithm: ${algorithm.name}`);
}