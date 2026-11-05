import type { webcrypto } from 'node:crypto';

/**
 * 文字列に秘密鍵で署名し、署名を base64url で返す。
 *
 * 文字列は UTF-8 のバイト列にしてから署名する。
 * 署名の方式は鍵のアルゴリズムによって次のように決まる。
 * - RSASSA-PKCS1-v1_5 の鍵は、鍵に設定されたハッシュ関数で署名する
 * - ECDSA の鍵は、曲線が P-256 なら SHA-256、P-384 なら SHA-384、それ以外なら SHA-512 で署名する
 *
 * @param data 署名する文字列
 * @param privateKey 署名に使う秘密鍵（`CryptoKey`）
 * @returns 署名（base64url）
 * @throws {Error} 鍵のアルゴリズムが RSASSA-PKCS1-v1_5 でも ECDSA でもないとき
 */
export async function sign(data: string, privateKey: CryptoKey): Promise<string> {
  const dataBuffer = stringToArrayBuffer(data);
  const algorithm = privateKey.algorithm;

  let signParams: webcrypto.AlgorithmIdentifier | webcrypto.EcdsaParams;

  if (algorithm.name === 'RSASSA-PKCS1-v1_5' && 'hash' in algorithm) {
    signParams = { name: 'RSASSA-PKCS1-v1_5' };
  } else if (algorithm.name === 'ECDSA' && 'namedCurve' in algorithm) {
    const namedCurve = (algorithm as webcrypto.EcKeyAlgorithm).namedCurve;
    // 曲線からハッシュ関数を選ぶ（P-256 は SHA-256、P-384 は SHA-384、それ以外は SHA-512）。
    const hash = namedCurve === 'P-256' ? 'SHA-256' : namedCurve === 'P-384' ? 'SHA-384' : 'SHA-512';
    signParams = { name: 'ECDSA', hash };
  } else {
    throw new Error(`Unsupported algorithm: ${algorithm.name}`);
  }

  const signature = await crypto.subtle.sign(signParams, privateKey, dataBuffer);
  return arrayBufferToBase64Url(signature);
}

/**
 * 署名を公開鍵で検証し、有効なら true を返す。
 *
 * 署名は base64url として復号し、文字列は UTF-8 のバイト列にしてから検証する。
 * 検証の方式は鍵のアルゴリズムで決まり、ハッシュ関数は `sign()` と同じ規則で選ぶ。
 *
 * @param data 署名された文字列
 * @param signature 署名（base64url）
 * @param publicKey 検証に使う公開鍵（`CryptoKey`）
 * @returns 署名が有効なら true、無効なら false
 * @throws {Error} 鍵のアルゴリズムが RSASSA-PKCS1-v1_5 でも ECDSA でもないとき
 * @throws {DOMException} 署名を base64 として復号できないとき（`atob()` が投げる）
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
    // 曲線からハッシュ関数を選ぶ（P-256 は SHA-256、P-384 は SHA-384、それ以外は SHA-512）。
    const hash = namedCurve === 'P-256' ? 'SHA-256' : namedCurve === 'P-384' ? 'SHA-384' : 'SHA-512';
    verifyParams = { name: 'ECDSA', hash };
  } else {
    throw new Error(`Unsupported algorithm: ${algorithm.name}`);
  }

  return crypto.subtle.verify(verifyParams, publicKey, signatureBuffer, dataBuffer);
}

/**
 * 指定したバイト数の乱数を base64url で返す。
 *
 * 乱数は、暗号論的に安全な乱数生成器（CSPRNG）である `crypto.getRandomValues()` で作る。
 *
 * @param byteLength 乱数のバイト数（例えば 32 なら 256 ビット）
 * @returns 乱数のバイト列を base64url で符号化した文字列
 * @throws {DOMException} `byteLength` が 65536 を超えるとき（`crypto.getRandomValues()` の上限）
 */
export function generateRandomString(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return arrayBufferToBase64Url(bytes.buffer);
}

/**
 * 2 つの文字列を定数時間で比べ、等しければ true を返す。
 *
 * `client_secret` などの認証情報を `===` で比べると、先頭から一致した長さによって応答時間が変わる。
 * そのため、時間差を測るタイミング攻撃で、シークレットを 1 文字ずつ推測されるおそれがある（OAuth 2.1 §7.4.1、RFC 6749 §10.10）。
 *
 * Web Crypto API には定数時間で比べる関数がないので、乱数の鍵で両方の文字列の HMAC-SHA256 を計算し、固定長の結果どうしを全バイトの XOR で比べる。
 * HMAC の鍵は呼び出しのたびに作り、取り出せない設定（`extractable` が false）にしてこの呼び出しの中だけで使うので、結果の長さや内容を観測しても元の文字列は復元できない。
 *
 * @spec OAuth 2.1 §7.4.1
 * @spec RFC 6749 §10.10
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
 * 文字列の SHA-256 ハッシュを base64url で返す。
 *
 * 文字列は UTF-8 のバイト列にしてからハッシュにする。
 *
 * @param data ハッシュにする文字列
 * @returns ハッシュ値（base64url、パディングなし）
 */
export async function sha256(data: string): Promise<string> {
  const buffer = stringToArrayBuffer(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return arrayBufferToBase64Url(hashBuffer);
}

/**
 * バイト列を base64url の文字列にして返す。
 *
 * base64 で符号化してから、`+` を `-` に、`/` を `_` に置き換え、末尾のパディング（`=`）を取り除く。
 *
 * @param buffer 符号化するバイト列
 * @returns base64url の文字列（パディングなし）
 */
export function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];

    // `noUncheckedIndexedAccess` で `number | undefined` になる型を `number` に絞り込む。
    // 範囲内の添字なので、実際には `undefined` にならない。
    if (byte === undefined) {
      throw new Error('Unexpected undefined byte in ArrayBuffer');
    }

    binary += String.fromCharCode(byte);
  }
  const base64 = btoa(binary);
  // base64 を base64url にする（`+` を `-` に、`/` を `_` に置き換え、末尾の `=` を取り除く）。
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * base64url の文字列を復号したバイト列を返す。
 *
 * `-` を `+` に、`_` を `/` に戻し、長さが 4 の倍数になるまで `=` を足してから、base64 として復号する。
 * `atob()` は base64url で使わない文字（`+`、`/`、`=`、空白など）の一部も受け付けるので、正規でない符号化を拒否する必要がある値（JWS の各部分など）には {@link base64UrlToArrayBufferStrict} を使う。
 *
 * @param base64url 復号する base64url の文字列
 * @returns 復号したバイト列
 * @throws {DOMException} base64 として復号できないとき（`atob()` が投げる）
 */
export function base64UrlToArrayBuffer(base64url: string): ArrayBuffer {
  // base64url を base64 に戻す（`-` を `+` に、`_` を `/` に置き換える）。
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  // 長さが 4 の倍数になるまで `=` を足す。
  const paddedBase64 = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(paddedBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    // 範囲内の添字では `charCodeAt()` は必ず数値を返すので、`undefined` の確認は要らない。
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
 * 文字と長さを検証してから base64url を復号して返す。
 *
 * base64url で使わない文字（`+`、`/`、`=`、空白など）を含む値と、長さを 4 で割った余りが 1 の値（base64 としてありえない長さ）を拒否してから、{@link base64UrlToArrayBuffer} で復号する。
 * `atob()` はこうした値の一部を受け付けてしまうので、改ざんを拒否する必要がある復号（JWS のヘッダーやペイロードなど）ではこの関数を使う。
 *
 * @throws {Error} base64url で使わない文字を含むとき、または長さを 4 で割った余りが 1 のとき
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
 * 文字列を UTF-8 で符号化したバイト列を返す。
 *
 * @param str 符号化する文字列
 * @returns UTF-8 のバイト列（`ArrayBuffer`）
 */
export function stringToArrayBuffer(str: string): ArrayBuffer {
  return new TextEncoder().encode(str).buffer;
}

/**
 * JWK の `n` から RSA のモジュラスのビット長を返す。
 *
 * JWK の `n` は、RSA のモジュラスを base64url で符号化した値である（RFC 7518 §6.3.1.1）。
 * 復号したバイト列から先頭のゼロのバイトを除き、残りのバイト数に 8 を掛けた値を返すので、結果は 8 の倍数になる。
 * 先頭のゼロを除くのは、ASN.1 の DER が最上位ビットの立つ値の前に `0x00` を付けるためで、そのゼロも数えるとビット長を大きく見積もってしまう。
 *
 * 鍵の強度の方針（`assertKeyStrength()`）が、RSA の鍵長が下限を満たすかを判定するために使う。
 * 副作用のない関数で、外部の依存を増やさないよう Web 標準の API だけで実装している。
 *
 * @spec RFC 7518 §6.3.1.1
 * @param jwkN JWK の `n`（base64url の文字列）
 * @returns モジュラスのビット長（すべてのバイトがゼロのときは 0）
 */
export function rsaModulusBitLength(jwkN: string): number {
  const bytes = new Uint8Array(base64UrlToArrayBuffer(jwkN));
  let i = 0;
  // 先頭のゼロのバイトを飛ばし、ビット長を大きく見積もらないようにする。
  while (i < bytes.length && bytes[i] === 0) {
    i++;
  }
  return (bytes.length - i) * 8;
}

/**
 * JWK の JSON 文字列を `CryptoKey` にして返す。
 *
 * JWK に `d` があれば秘密鍵として、なければ公開鍵として読み込む。
 * `keyUsages` を省略すると、用途は秘密鍵なら `['sign']`、公開鍵なら `['verify']` になる。
 *
 * `algorithm` を省略すると、RS256（RSASSA-PKCS1-v1_5 と SHA-256）として読み込む。
 * `algorithm` に指定できるアルゴリズムと、対応する JWA の名前は次のとおりである。
 * - RS256、RS384、RS512: RSASSA-PKCS1-v1_5 と SHA-256、SHA-384、SHA-512
 * - ES256、ES384、ES512: ECDSA と P-256、P-384、P-521（ハッシュ関数は SHA-256、SHA-384、SHA-512）
 *
 * RS256 は、OpenID Connect Core 1.0 で既定とされるアルゴリズムである（SHOULD）。
 * ES256、ES384、ES512 は楕円曲線暗号による高速で安全な署名方式なので、こちらを推奨する。
 *
 * @param jwkString JWK の JSON 文字列
 * @param algorithm 読み込むときのアルゴリズム（既定は RS256 の RSASSA-PKCS1-v1_5 と SHA-256）
 * @param extractable 鍵を取り出せるようにするか（既定は true）
 * @param keyUsages 鍵の用途（既定は秘密鍵なら `['sign']`、公開鍵なら `['verify']`）
 * @returns 読み込んだ鍵
 * @throws {SyntaxError} `jwkString` が JSON として読み取れないとき
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

  // JWK に `d`（秘密鍵の値）があれば秘密鍵、なければ公開鍵とみなす。
  const isPrivateKey = jwk.kty === 'RSA' ? 'd' in jwk : 'd' in jwk;

  // 用途が指定されていなければ、秘密鍵なら `sign`、公開鍵なら `verify` にする。
  const usages = keyUsages ?? (isPrivateKey ? ['sign'] : ['verify']);

  return crypto.subtle.importKey('jwk', jwk, algorithm, extractable, usages);
}

/**
 * 秘密鍵の JWK を取り出せない `CryptoKey` にして返す。
 *
 * 鍵は取り出せない設定（`extractable` が false）で読み込むので、読み込んだ鍵を JWK などとして書き出すことはできない。
 * `keyUsages` を省略すると、JWK に `d` があれば `['sign']`、なければ `['verify']` を用途にする。
 *
 * `algorithm` を省略すると、RS256（RSASSA-PKCS1-v1_5 と SHA-256）として読み込む。
 * `algorithm` に指定できるアルゴリズムと、対応する JWA の名前は次のとおりである。
 * - RS256、RS384、RS512: RSASSA-PKCS1-v1_5 と SHA-256、SHA-384、SHA-512
 * - ES256、ES384、ES512: ECDSA と P-256、P-384、P-521（ハッシュ関数は SHA-256、SHA-384、SHA-512）
 *
 * RS256 は、OpenID Connect Core 1.0 で既定とされるアルゴリズムである（SHOULD）。
 * ES256、ES384、ES512 は楕円曲線暗号による高速で安全な署名方式なので、こちらを推奨する。
 *
 * @param jwkString 秘密鍵の JWK の JSON 文字列
 * @param algorithm 読み込むときのアルゴリズム（既定は RS256 の RSASSA-PKCS1-v1_5 と SHA-256）
 * @param keyUsages 鍵の用途（既定は JWK に `d` があれば `['sign']`、なければ `['verify']`）
 * @returns 読み込んだ鍵（取り出せない設定）
 * @throws {SyntaxError} `jwkString` が JSON として読み取れないとき
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
 * 公開鍵の JWK を `CryptoKey` にして返す。
 *
 * 鍵は取り出せる設定（`extractable` が true）で読み込む。
 * `keyUsages` を省略すると、JWK に `d` がなければ `['verify']`、あれば `['sign']` を用途にする。
 *
 * `algorithm` を省略すると、RS256（RSASSA-PKCS1-v1_5 と SHA-256）として読み込む。
 * `algorithm` に指定できるアルゴリズムと、対応する JWA の名前は次のとおりである。
 * - RS256、RS384、RS512: RSASSA-PKCS1-v1_5 と SHA-256、SHA-384、SHA-512
 * - ES256、ES384、ES512: ECDSA と P-256、P-384、P-521（ハッシュ関数は SHA-256、SHA-384、SHA-512）
 *
 * RS256 は、OpenID Connect Core 1.0 で既定とされるアルゴリズムである（SHOULD）。
 * ES256、ES384、ES512 は楕円曲線暗号による高速で安全な署名方式なので、こちらを推奨する。
 *
 * @param jwkString 公開鍵の JWK の JSON 文字列
 * @param algorithm 読み込むときのアルゴリズム（既定は RS256 の RSASSA-PKCS1-v1_5 と SHA-256）
 * @param keyUsages 鍵の用途（既定は JWK に `d` がなければ `['verify']`、あれば `['sign']`）
 * @returns 読み込んだ鍵（取り出せる設定）
 * @throws {SyntaxError} `jwkString` が JSON として読み取れないとき
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
 * `CryptoKey` から読み込み用のアルゴリズムの指定を返す。
 *
 * 返す値は `crypto.subtle.importKey()` に渡すアルゴリズムの指定の形で、RSASSA-PKCS1-v1_5 の鍵には名前とハッシュ関数を、ECDSA の鍵には名前と曲線を入れる。
 * 対応する JWA の名前は次のとおりである。
 * - RS256、RS384、RS512: RSASSA-PKCS1-v1_5 と SHA-256、SHA-384、SHA-512
 * - ES256、ES384、ES512: ECDSA と P-256、P-384、P-521
 *
 * RS256 は、OpenID Connect Core 1.0 で既定とされるアルゴリズムである（SHOULD）。
 * ES256、ES384、ES512 は楕円曲線暗号による高速で安全な署名方式なので、こちらを推奨する。
 *
 * ハッシュ関数が SHA-1 の RSA の鍵は、弱いので拒否する。
 *
 * @param key アルゴリズムを調べる鍵
 * @returns `RsaHashedImportParams` か `EcKeyImportParams`
 * @throws {Error} 鍵のアルゴリズムが RSASSA-PKCS1-v1_5 でも ECDSA でもないとき、またはハッシュ関数が SHA-1 のとき
 */
export function extractAlgorithmParams(key: CryptoKey): webcrypto.RsaHashedImportParams | webcrypto.EcKeyImportParams {
  const algorithm = key.algorithm;

  if (algorithm.name === 'RSASSA-PKCS1-v1_5' && 'hash' in algorithm) {
    const rsaAlgo = algorithm as webcrypto.RsaHashedKeyAlgorithm;
    const hashName = rsaAlgo.hash.name;

    // 弱いハッシュ関数（SHA-1）を使う鍵を拒否する。
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
 * JWK から `importKey()` 用のアルゴリズムの指定を返す。
 *
 * 返す値は `crypto.subtle.importKey()` に渡すアルゴリズムの指定で、JWK の `kty`、`alg`、`crv` から次のように決める。
 * - `kty` が `RSA` で `alg` が `RS256`、`RS384`、`RS512` なら、RSASSA-PKCS1-v1_5 と SHA-256、SHA-384、SHA-512
 * - `kty` が `EC` で `crv` が `P-256`、`P-384`、`P-521` なら、ECDSA とその曲線
 *
 * JWKS のルートで RS256、RS384、RS512 を決め打ちすると ES256 などの鍵を扱えないので、JWK の項目からアルゴリズムを決める。
 *
 * @throws {Error} `kty` が `RSA` でも `EC` でもないとき、RSA の鍵の `alg` が上の 3 つのどれでもないとき（未指定も含む）、または EC の鍵の `crv` が上の 3 つのどれでもないとき（未指定も含む）
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

/**
 * `alg` が RS256、RS384、RS512 なら、その署名に使うハッシュの名前を返し、ほかの alg なら `undefined` を返す。
 *
 * @spec RFC 7518 §3.3
 */
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

/**
 * `alg` が ES256、ES384、ES512 なら、その署名に使う曲線の名前を返し、ほかの alg なら `undefined` を返す。
 *
 * @spec RFC 7518 §3.4
 */
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

/**
 * 曲線 `crv` が P-256、P-384、P-521 なら、その曲線で署名する ES256、ES384、ES512 を返し、ほかの曲線なら `undefined` を返す。
 *
 * @spec RFC 7518 §3.4
 */
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
 * JWK で署名を検証してよい、ただ一つの JWS の署名アルゴリズムを返し、決められなければ `undefined` を返す。
 *
 * 鍵はちょうど一つのアルゴリズムで使い、それを処理のときに確かめなければならない（RFC 8725 §3.1 の MUST）。
 * 署名を検証する側は、JOSE ヘッダーの `alg` がこの関数の返す値と一致する鍵だけを使う。
 * - RSA の鍵: `alg` が RS256、RS384、RS512 ならその値を、`alg` がなければ RS256 を返し、ほかの `alg`（PS256 など）なら `undefined` を返す。`alg` は省略できる（RFC 7517 §4.4）ので、省く JWK Set が多い。DCR の `validateJwks()` の正規化と同じ規則である
 * - EC の鍵: `crv` が P-256、P-384、P-521 ならそれぞれ ES256、ES384、ES512 を返し、`alg` があって `crv` と食い違えば `undefined` を返す
 * - ほかの鍵（`oct`、`OKP` など）: `undefined` を返す
 *
 * @spec RFC 8725 §3.1
 * @spec RFC 7517 §4.4
 * @spec RFC 7518 §3.4
 * @param jwk 公開鍵の JWK
 * @returns その鍵で検証してよい alg。決められなければ `undefined`
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
 * 公開鍵の JWK を、JWS の `alg` の署名の検証にだけ使える、エクスポートできない `CryptoKey` としてインポートして返す。
 *
 * インポートの引数は、JWK ではなく `alg` から組み立てる。
 * RS 系は RSASSA-PKCS1-v1_5 と対応するハッシュ（RFC 7518 §3.3）、ES 系は対応する曲線の ECDSA（RFC 7518 §3.4）である。
 * `verify()` は EC の曲線からハッシュを選ぶので、曲線を `alg` に固定すれば、検証のアルゴリズムは `alg` と一致する。
 *
 * {@link resolveJwkSigningAlg} が `alg` と同じ値を返さない鍵（`kty`、`crv`、`alg` の食い違いや、`alg` のない RSA の鍵を RS384 で使う場合など）は拒否する（RFC 8725 §3.1）。
 * 2048 ビット未満の RSA の鍵も拒否する（RFC 7518 §3.3 の MUST）。
 * インポートするのは公開鍵のメンバー（RSA は `kty`、`n`、`e`、EC は `kty`、`crv`、`x`、`y`）だけで、`use`、`key_ops`、秘密鍵のメンバーは渡さない。
 *
 * @spec RFC 8725 §3.1
 * @spec RFC 7518 §3.3 / §3.4
 * @param jwk 公開鍵の JWK
 * @param alg 検証する JWS の JOSE ヘッダーの `alg`
 * @returns 検証にだけ使える、エクスポートできない公開鍵
 * @throws {Error} `alg` と鍵が対応しないとき、RSA の鍵が短いとき、鍵のメンバーが欠けているとき
 * @throws {DOMException} WebCrypto が鍵を受け付けないとき（`crypto.subtle.importKey()` が投げる）
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

  // resolveJwkSigningAlg() は RS 系と ES 系しか返さないので、ここには来ない。
  throw new Error(`The JWK cannot be used with ${alg}`);
}

/**
 * 署名アルゴリズムの名前から、ハッシュ関数の名前を返す。
 *
 * 返す名前は、ハッシュのクレーム（`at_hash`、`c_hash`）の計算に使う Web Crypto のダイジェストの名前である。
 * `at_hash` のハッシュ関数は、ID トークンの JOSE ヘッダーの `alg` が使うハッシュ関数と同じにする必要がある（OIDC Core 1.0 §3.1.3.6）。
 * RFC 7518 §3.1 の命名（`RSxxx`、`ESxxx`、`PSxxx`）に従い、名前の末尾の 3 桁（ビット長）で判別する。
 * 例えば `RS256`、`ES256`、`PS256` は SHA-256 になり、末尾が 384 なら SHA-384、512 なら SHA-512 になる。
 *
 * @spec OIDC Core 1.0 §3.1.3.6
 * @spec RFC 7518 §3.1
 * @param alg JWA の署名アルゴリズムの名前（例えば `RS256`、`ES384`、`RS512`）
 * @returns `SHA-256`、`SHA-384`、`SHA-512` のいずれか
 * @throws {Error} 名前の末尾が 256、384、512 のどれでもないとき
 */
export function jwaToHashName(alg: string): 'SHA-256' | 'SHA-384' | 'SHA-512' {
  if (alg.endsWith('256')) return 'SHA-256';
  if (alg.endsWith('384')) return 'SHA-384';
  if (alg.endsWith('512')) return 'SHA-512';
  throw new Error(`Unsupported alg for hash claim: ${alg}`);
}

/**
 * 鍵のアルゴリズムを JWA の名前にして返す。
 *
 * RSASSA-PKCS1-v1_5 の鍵は、ハッシュ関数が SHA-256 なら `RS256`、SHA-384 なら `RS384`、それ以外なら `RS512` を返す。
 * ECDSA の鍵は、曲線が P-256 なら `ES256`、P-384 なら `ES384`、それ以外なら `ES512` を返す。
 *
 * @throws {Error} 鍵のアルゴリズムが RSASSA-PKCS1-v1_5 でも ECDSA でもないとき
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