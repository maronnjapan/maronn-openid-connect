/**
 * Google の ID トークン（compact JWS, RS256）を読むための最小限の JOSE 処理。
 *
 * core にも同種の処理（`crypto-utils.ts`）があるが、core はそれらを公開 API として
 * export していない。core の公開 API を増やす（= core のリリース）のではなく、拡張
 * package は独立性を優先して重複を許容する（experimental と同じ方針）。
 *
 * Web Crypto API のみで実装し、Node.js 固有 API は使わない。
 */
import type { webcrypto } from 'node:crypto';

import { GoogleLoginError, GoogleLoginErrorCode } from './errors.js';

// RFC 7515 §2 / Appendix C: base64url は URL-safe アルファベットでパディング無し。
// 正規のエンコードには '+' '/' '=' や空白が現れず、長さ mod 4 が 1 になることもない。
// `atob` はこれらを黙って受け入れるものがあるため、署名検証対象の JWS セグメントは
// 厳密にデコードして非正規な入力を拒否する（RFC 8725 §3.11 strict parsing）。
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

/**
 * base64url 文字列を厳密に検証してデコードする。
 *
 * @throws {Error} base64url アルファベット外の文字を含む、または長さが不正な場合
 */
export function decodeBase64UrlStrict(base64url: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL_PATTERN.test(base64url)) {
    throw new Error('Invalid base64url: contains characters outside the base64url alphabet');
  }
  if (base64url.length % 4 === 1) {
    throw new Error('Invalid base64url: malformed length');
  }
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * base64url でエンコードされた JSON オブジェクトをデコードする。
 *
 * @throws {Error} base64url として不正、JSON として不正、またはオブジェクトでない場合
 */
export function decodeBase64UrlJsonObject(base64url: string): Record<string, unknown> {
  const text = new TextDecoder().decode(decodeBase64UrlStrict(base64url));
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Decoded JSON is not an object');
  }
  return value as Record<string, unknown>;
}

/**
 * compact JWS を分解した結果。
 */
export interface CompactJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** 署名対象（`<header>.<payload>`、base64url のまま）。 */
  signingInput: string;
  signature: Uint8Array<ArrayBuffer>;
}

/**
 * compact JWS（`header.payload.signature`）を分解する。署名の検証は行わない。
 *
 * RFC 7515 §7.1: セグメントは 3 つちょうど。ヘッダーとペイロードは JSON オブジェクト。
 *
 * @throws {GoogleLoginError} `malformed_id_token`
 */
export function parseCompactJws(token: string): CompactJws {
  const segments = token.split('.');
  if (segments.length !== 3) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.MalformedIdToken,
      'ID token is not a valid JWS compact serialization',
    );
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    header = decodeBase64UrlJsonObject(headerSegment);
    payload = decodeBase64UrlJsonObject(payloadSegment);
    signature = decodeBase64UrlStrict(signatureSegment);
  } catch {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.MalformedIdToken,
      'ID token header, payload or signature is not valid base64url JSON',
    );
  }

  return {
    header,
    payload,
    signingInput: `${headerSegment}.${payloadSegment}`,
    signature,
  };
}

/**
 * RS256（RSASSA-PKCS1-v1_5 with SHA-256）の署名を検証する。
 *
 * @param signingInput 署名対象（`<header>.<payload>`）
 * @param signature 署名バイト列
 * @param jwk RSA 公開鍵の JWK（`kty` / `n` / `e`）
 * @returns 署名が有効なら true
 */
export async function verifyRs256Signature(
  signingInput: string,
  signature: Uint8Array<ArrayBuffer>,
  jwk: { kty: string; n: string; e: string },
): Promise<boolean> {
  // Google の JWK Set には kid / use / alg も入っているが、importKey には鍵素材だけを渡す。
  // 未知メンバーの扱いはランタイム実装に依存するため、こちらで正規化する。
  const keyData: webcrypto.JsonWebKey = { kty: jwk.kty, n: jwk.n, e: jwk.e };
  const key = await crypto.subtle.importKey(
    'jwk',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    signature,
    new TextEncoder().encode(signingInput),
  );
}

/**
 * 2 つの文字列を constant-time で比較する。
 *
 * Web Crypto API には timingSafeEqual が無いので、ランダム鍵で HMAC-SHA256 をかけ、
 * 固定長ダイジェスト同士を XOR ベースで比較する（core の `timingSafeEqual` と同じ手法）。
 * HMAC 鍵はこの呼び出し限りのもので、文字列長や内容を観測しても元の値を復元できない。
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(a)),
    crypto.subtle.sign('HMAC', key, encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  if (bytesA.length !== bytesB.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i]! ^ bytesB[i]!;
  }
  return diff === 0;
}
