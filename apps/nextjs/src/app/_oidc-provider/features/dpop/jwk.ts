/**
 * DPoP proof の `jwk` ヘッダーの公開鍵と、その JWK Thumbprint。
 *
 * DPoP proof は、クライアントが選んだ鍵ペアの秘密鍵で署名し、公開鍵を JOSE ヘッダーの `jwk` に入れて送る（RFC 9449 §4.2）。
 * OP はその公開鍵で署名を検証し、公開鍵の JWK Thumbprint（RFC 7638、SHA-256）でトークンを鍵に束縛する（RFC 9449 §6）。
 */
import { decodeBase64Url, encodeBase64Url } from './base64url';
import { DpopError } from './errors';

/**
 * この実装が DPoP proof の署名を検証できる JWS のアルゴリズム（RFC 7518 §3.3-§3.5、RFC 8037 §3.1）。
 *
 * どれも非対称鍵の署名で、`none` と MAC（HS 系）は含めない（RFC 9449 §4.2 / §4.3）。
 * `EdDSA` は Ed25519 の鍵だけを受け付ける。
 */
export const SUPPORTED_DPOP_SIGNING_ALGS = [
  'ES256',
  'ES384',
  'ES512',
  'PS256',
  'PS384',
  'PS512',
  'RS256',
  'RS384',
  'RS512',
  'EdDSA',
] as const;

/** {@link SUPPORTED_DPOP_SIGNING_ALGS} のどれか。 */
export type DpopSigningAlg = (typeof SUPPORTED_DPOP_SIGNING_ALGS)[number];

/** DPoP proof の `jwk` ヘッダーに入った公開鍵（{@link validateDpopProofJwk} が確かめた後の値）。 */
export interface DpopPublicJwk {
  kty: 'RSA' | 'EC' | 'OKP';
  /** RSA の公開鍵のメンバー */
  n?: string;
  e?: string;
  /** EC と OKP の公開鍵のメンバー */
  crv?: string;
  x?: string;
  y?: string;
  [member: string]: unknown;
}

/** 秘密鍵か対称鍵のメンバー（RFC 7518 §6.2.2 / §6.3.2 / §6.4、RFC 8037 §2）。DPoP proof の `jwk` に含めてはならない（RFC 9449 §4.2）。 */
const PRIVATE_KEY_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

/** RSA の鍵に求める最小のビット長（RFC 7518 §3.3 / §3.5 の MUST）。 */
const MIN_RSA_MODULUS_BITS = 2048;

/** アルゴリズムごとの鍵の種類と、Web Crypto のインポートと検証のパラメータ。 */
interface AlgorithmProfile {
  kty: DpopPublicJwk['kty'];
  crv?: string;
  /** `crypto.subtle.importKey()` のアルゴリズム（RSASSA-PKCS1-v1_5 と RSA-PSS は `hash`、ECDSA は `namedCurve` を持つ） */
  importParams: { name: string; hash?: string; namedCurve?: string };
  /** `crypto.subtle.verify()` のアルゴリズム（RSA-PSS は `saltLength`、ECDSA は `hash` を持つ） */
  verifyParams: { name: string; saltLength?: number; hash?: string };
  /** ECDSA の署名（`r || s`）のバイト長 */
  signatureLength?: number;
}

/**
 * JWS のアルゴリズムの名前から、鍵の種類と Web Crypto のパラメータを返す。
 *
 * {@link SUPPORTED_DPOP_SIGNING_ALGS} にないアルゴリズムには `undefined` を返す。
 *
 * @spec RFC 7518 §3.1
 * @spec RFC 8037 §3.1
 */
function profileOf(alg: string): AlgorithmProfile | undefined {
  const rsaHash = /^(?:RS|PS)(256|384|512)$/.exec(alg)?.[1];
  if (rsaHash !== undefined) {
    const bits = Number(rsaHash);
    // RSASSA-PSS の salt は、ハッシュの出力と同じ長さにする（RFC 7518 §3.5）。
    return alg.startsWith('PS')
      ? { kty: 'RSA', importParams: { name: 'RSA-PSS', hash: `SHA-${bits}` }, verifyParams: { name: 'RSA-PSS', saltLength: bits / 8 } }
      : { kty: 'RSA', importParams: { name: 'RSASSA-PKCS1-v1_5', hash: `SHA-${bits}` }, verifyParams: { name: 'RSASSA-PKCS1-v1_5' } };
  }
  switch (alg) {
    case 'ES256':
      return ecProfile('P-256', 'SHA-256', 64);
    case 'ES384':
      return ecProfile('P-384', 'SHA-384', 96);
    case 'ES512':
      return ecProfile('P-521', 'SHA-512', 132);
    case 'EdDSA':
      return { kty: 'OKP', crv: 'Ed25519', importParams: { name: 'Ed25519' }, verifyParams: { name: 'Ed25519' } };
    default:
      return undefined;
  }
}

/**
 * ECDSA のアルゴリズムの鍵の種類と Web Crypto のパラメータを返す。
 *
 * @spec RFC 7518 §3.4
 */
function ecProfile(crv: string, hash: string, signatureLength: number): AlgorithmProfile {
  return {
    kty: 'EC',
    crv,
    importParams: { name: 'ECDSA', namedCurve: crv },
    verifyParams: { name: 'ECDSA', hash },
    signatureLength,
  };
}

/**
 * アルゴリズムが、この実装が DPoP proof に検証できる非対称鍵の署名かを返す。
 *
 * @spec RFC 9449 §4.3
 */
export function isSupportedDpopSigningAlg(alg: string): alg is DpopSigningAlg {
  return (SUPPORTED_DPOP_SIGNING_ALGS as readonly string[]).includes(alg);
}

/**
 * DPoP proof の `jwk` ヘッダーが `alg` で使える公開鍵であることを確かめ、公開鍵として返す。
 *
 * 次のどれかに当たると拒否する。
 * - JSON のオブジェクトでない
 * - 秘密鍵か対称鍵のメンバー（`d`、`p`、`q`、`dp`、`dq`、`qi`、`oth`、`k`）を含む（RFC 9449 §4.2 / §4.3 の 7.）
 * - `kty`（と EC・OKP の `crv`）が `alg` に合わない
 * - 公開鍵のメンバー（RSA は `n` と `e`、EC は `x` と `y`、OKP は `x`）が base64url の文字列でない
 * - RSA の鍵が 2048 ビットより短い（RFC 7518 §3.3 / §3.5）
 *
 * @spec RFC 9449 §4.2
 * @spec RFC 9449 §4.3
 * @throws {DpopError} `invalid_dpop_proof`: `jwk` が `alg` で使える公開鍵でないとき
 */
export function validateDpopProofJwk(jwk: unknown, alg: string): DpopPublicJwk {
  if (typeof jwk !== 'object' || jwk === null || Array.isArray(jwk)) {
    throw invalidJwk('The DPoP proof jwk header is not a JSON object');
  }
  const key = jwk as Record<string, unknown>;
  if (PRIVATE_KEY_MEMBERS.some((member) => member in key)) {
    throw invalidJwk('The DPoP proof jwk header must not contain a private key');
  }
  const profile = profileOf(alg);
  if (profile === undefined || key.kty !== profile.kty) {
    throw invalidJwk('The DPoP proof jwk header does not match the alg');
  }
  if (profile.crv !== undefined && key.crv !== profile.crv) {
    throw invalidJwk('The DPoP proof jwk header does not match the alg');
  }
  const members = profile.kty === 'RSA' ? ['n', 'e'] : profile.kty === 'EC' ? ['x', 'y'] : ['x'];
  for (const member of members) {
    const value = key[member];
    if (typeof value !== 'string' || value === '' || decodeBase64Url(value) === undefined) {
      throw invalidJwk('The DPoP proof jwk header is not a valid public key');
    }
  }
  if (profile.kty === 'RSA' && rsaModulusBits(key.n as string) < MIN_RSA_MODULUS_BITS) {
    throw invalidJwk('RSA keys shorter than 2048 bits are not accepted');
  }
  return key as DpopPublicJwk;
}

/**
 * RSA の公開鍵の `n`（base64url）から、法のビット長を返す。
 *
 * 先頭の 0 のバイトは数えない。
 *
 * @spec RFC 7518 §6.3.1.1
 */
function rsaModulusBits(n: string): number {
  const bytes = decodeBase64Url(n) ?? new Uint8Array();
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start += 1;
  if (start === bytes.length) return 0;
  return (bytes.length - start - 1) * 8 + (32 - Math.clz32(bytes[start] as number));
}

/**
 * 公開鍵の JWK Thumbprint（SHA-256、base64url）を返す。
 *
 * 鍵の種類ごとの必須のメンバーだけを辞書順に並べ、空白を入れない JSON にしてハッシュにする（RFC 7638 §3.2 / §3.3）。
 * RSA は `e`、`kty`、`n`、EC は `crv`、`kty`、`x`、`y`、OKP は `crv`、`kty`、`x` を使う（RFC 8037 §2）。
 * DPoP は、この値でトークンを鍵に束縛する（`cnf` の `jkt`、RFC 9449 §6.1）。
 *
 * @spec RFC 7638 §3
 * @spec RFC 9449 §6.1
 */
export async function computeJwkThumbprint(jwk: DpopPublicJwk): Promise<string> {
  const required: Record<string, unknown> =
    jwk.kty === 'RSA'
      ? { e: jwk.e, kty: jwk.kty, n: jwk.n }
      : jwk.kty === 'EC'
        ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
        : { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(required)));
  return encodeBase64Url(digest);
}

/**
 * DPoP proof の署名を、`jwk` ヘッダーの公開鍵で検証した結果を返す。
 *
 * 公開鍵は `alg` のとおりにインポートし、検証にだけ使う。
 * ECDSA の署名は JWS の形（`r || s`、RFC 7518 §3.4）のまま Web Crypto に渡すので、長さが曲線に合わない署名は検証せずに `false` を返す。
 * 鍵をインポートできないときも `false` を返す。
 *
 * @spec RFC 7515 §5.2
 * @spec RFC 7518 §3.3 / §3.4 / §3.5
 * @spec RFC 8037 §3.1
 */
export async function verifyJwsSignature(
  jwk: DpopPublicJwk,
  alg: string,
  signingInput: string,
  signature: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const profile = profileOf(alg);
  if (profile === undefined) return false;
  if (profile.signatureLength !== undefined && signature.length !== profile.signatureLength) return false;
  const publicMembers =
    profile.kty === 'RSA'
      ? { kty: 'RSA', n: jwk.n, e: jwk.e }
      : profile.kty === 'EC'
        ? { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y }
        : { kty: 'OKP', crv: jwk.crv, x: jwk.x };
  try {
    const key = await crypto.subtle.importKey('jwk', publicMembers as JsonWebKey, profile.importParams, false, ['verify']);
    return await crypto.subtle.verify(profile.verifyParams, key, signature, new TextEncoder().encode(signingInput));
  } catch {
    return false;
  }
}

/**
 * `jwk` ヘッダーの不備を表す `invalid_dpop_proof` のエラーを返す。
 *
 * @spec RFC 9449 §5
 */
function invalidJwk(description: string): DpopError {
  return new DpopError('invalid_dpop_proof', description);
}
