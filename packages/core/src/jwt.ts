/**
 * JWT（JWS Compact Serialization）の組み立てと署名
 * RFC 7515 / RFC 7519
 */
import { arrayBufferToBase64Url, sign, stringToArrayBuffer } from './crypto-utils.js';

/**
 * `alg` と `typ` を持つ JOSE ヘッダーを返す。
 *
 * `keyId` が空でないときだけ `kid` を加える。
 * 鍵に合う `alg` を選ぶのは呼び出し側である。
 *
 * @spec RFC 7515 §4.1
 */
export function buildJoseHeader(
  algorithm: string,
  type: string,
  keyId?: string,
): Record<string, string> {
  const header: Record<string, string> = { alg: algorithm, typ: type };
  if (keyId) header.kid = keyId;
  return header;
}

/**
 * ヘッダーとペイロードから JWS の署名入力を作って返す。
 *
 * それぞれを `JSON.stringify()` で JSON の文字列にし、UTF-8 のバイト列を base64url で符号化して、`.` でつなぐ。
 * クレームの値は検証しない。
 *
 * @spec RFC 7515 §5.1
 */
export function encodeJwtSigningInput(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  const encode = (value: Record<string, unknown>) =>
    arrayBufferToBase64Url(stringToArrayBuffer(JSON.stringify(value)));
  return `${encode(header)}.${encode(payload)}`;
}

/**
 * ヘッダーとペイロードに署名し、JWT の文字列を返す。
 *
 * 返す値は JWS のコンパクト形式（署名入力と、base64url で符号化した署名を `.` でつないだ文字列）である。
 * 署名のアルゴリズムは `privateKey` のアルゴリズムで決まり、ヘッダーの `alg` は参照しない。
 * そのため、クレームの検証と、鍵に合う `alg` をヘッダーに入れることは、呼び出し側が済ませておく。
 * RSASSA-PKCS1-v1_5 と ECDSA 以外の鍵には `Error` を投げる。
 */
export async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
): Promise<string> {
  const signingInput = encodeJwtSigningInput(header, payload);
  const signature = await sign(signingInput, privateKey);
  return `${signingInput}.${signature}`;
}
