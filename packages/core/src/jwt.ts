/**
 * JWT（JWS Compact Serialization）の組み立てと署名
 * RFC 7515 / RFC 7519
 */
import { arrayBufferToBase64Url, sign, stringToArrayBuffer } from './crypto-utils.js';

/**
 * RFC 7515 §4.1: alg と typ、指定があれば kid を持つ JOSE ヘッダーを組み立てる。
 * 鍵に合う alg の選択は呼び出し側が行う。
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
 * RFC 7515 §5.1: ヘッダーとペイロードを base64url で連結した署名入力を作る。クレームは検証しない。
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
 * ヘッダーとペイロードに署名し、JWS Compact Serialization を返す。
 * クレームの検証と、鍵に合うヘッダーの選択は呼び出し側が済ませておく前提。
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
