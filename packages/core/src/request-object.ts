/**
 * Request Object (passed by value) processing.
 *
 * OIDC Core 1.0 §6.1: a Request Object is a JWT whose claims are the
 * Authorization Request parameters. When signed (JWS) it protects the integrity
 * of the request parameter values. This module parses the compact JWS, verifies
 * the signature against the client's registered keys, and returns the decoded
 * claim set so the caller can merge it into the Authorization Request.
 */
import { verify, base64UrlToArrayBuffer, extractAlgorithmParamsFromJwk } from './crypto-utils.js';
import type { Jwk, JwkSet } from './jwks.js';

/**
 * Request Object のパース・署名検証に失敗したことを表すエラー。
 *
 * 呼び出し側（`resolveRequestObjectParams`）はこれを捕捉して
 * `invalid_request_object`（OIDC Core 1.0 §6.3）の `AuthorizationError` に変換する。
 */
export class RequestObjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestObjectError';
  }
}

/**
 * Request Object のパースオプション。
 */
export interface ParseRequestObjectOptions {
  /**
   * 署名検証に使うクライアント登録の公開鍵集合（JWKS）。
   * 署名付き（`alg !== "none"`）Request Object の検証に必須。
   */
  jwks?: JwkSet;
  /**
   * 受理する JWS 署名アルゴリズム。OIDC Core 1.0 §6.1 / OIDC Basic OP の既定は `RS256`。
   */
  supportedSigningAlgs: string[];
  /**
   * 署名無し（`alg: "none"`）Request Object を受理するか。
   *
   * OIDF Conformance Suite の一部 module は unsigned Request Object を送るため、
   * Basic OP conformance 互換目的でのみ true にする。署名付きが本実装の主対象。
   */
  allowUnsigned: boolean;
}

/**
 * JWT のセグメントを復号し、JSON として解析して返す。
 *
 * セグメントを base64url として復号し、UTF-8 の文字列として読んでから `JSON.parse()` に渡す。
 * 解析した値の型は確かめないので、オブジェクト以外の JSON の値もそのまま返す。
 * 標準の base64 の `+` と `/` や、パディングの `=` を含む値も復号する（base64url の厳密な検査はしない）。
 *
 * @throws {DOMException} `InvalidCharacterError`: base64 として復号できないとき
 * @throws {SyntaxError} 復号した文字列を JSON として解析できないとき
 */
function decodeJwtSegment(segment: string): unknown {
  const json = new TextDecoder().decode(base64UrlToArrayBuffer(segment));
  return JSON.parse(json);
}

/**
 * リクエストオブジェクトを検証し、ペイロードを返す。
 *
 * `request` は JWS のコンパクト形式（`.` で区切った三つのセグメント）でなければならない。
 * 返すペイロードは、認可リクエストのパラメータを持つ JSON オブジェクトである。
 *
 * 署名の検証には、ヘッダーに `kid` があれば `kid` が一致する `jwks` の鍵を、なければ `jwks` のすべての鍵を、順に試す。
 * `alg` を持つ鍵は、ヘッダーの `alg` と一致するときだけ使い、インポートできない鍵は飛ばす。
 * どれか一つの鍵で署名を検証できれば、ペイロードを返す。
 *
 * 次のときは `RequestObjectError` を投げる:
 * - `request` が文字列でないか空のとき、または `.` で区切ったセグメントが三つでないとき（五つのセグメントからなる JWE も拒否する）。
 * - ヘッダーかペイロードを JSON オブジェクトとして復号できないとき、またはヘッダーに `alg` がないとき。
 * - `alg` が `none` で、`allowUnsigned` が `false` のとき、または署名のセグメントが空でないとき。
 * - `alg` が `supportedSigningAlgs` にないとき、または `jwks` がないか空のとき。
 * - ヘッダーの `kid` と一致する鍵がないとき、またはどの鍵でも署名を検証できないとき。
 *
 * @spec OIDC Core 1.0 §6.1
 * @throws {RequestObjectError} 形式が不正なとき、`alg` に対応していないとき、鍵が見つからないとき、署名を検証できないとき
 */
export async function parseRequestObject(
  request: string,
  options: ParseRequestObjectOptions,
): Promise<Record<string, unknown>> {
  if (typeof request !== 'string' || request.length === 0) {
    throw new RequestObjectError('request object is empty');
  }

  const parts = request.split('.');
  // リクエストオブジェクトは JWT であり、そのうち三つのセグメントからなる JWS のコンパクト形式だけを受け付ける（OIDC Core 1.0 §6.1）。
  // 五つのセグメントからなる JWE など、ほかの形は拒否する。
  if (parts.length !== 3) {
    throw new RequestObjectError(
      'request object is not a JWS compact serialization',
    );
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: Record<string, unknown>;
  try {
    const decoded = decodeJwtSegment(headerB64);
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new Error('header is not a JSON object');
    }
    header = decoded as Record<string, unknown>;
  } catch {
    throw new RequestObjectError('request object header is not valid base64url JSON');
  }

  let payload: unknown;
  try {
    payload = decodeJwtSegment(payloadB64);
  } catch {
    throw new RequestObjectError('request object payload is not valid base64url JSON');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new RequestObjectError('request object payload is not a JSON object');
  }

  const alg = typeof header['alg'] === 'string' ? (header['alg'] as string) : undefined;
  if (!alg) {
    throw new RequestObjectError('request object header is missing alg');
  }

  if (alg === 'none') {
    if (!options.allowUnsigned) {
      throw new RequestObjectError('unsigned request object (alg=none) is not supported');
    }
    // `none` のアルゴリズムでは署名のセグメントが空になるので、空でなければ拒否する（RFC 7515 §6）。
    if (signatureB64 !== '') {
      throw new RequestObjectError('unsigned request object must not carry a signature');
    }
    return payload as Record<string, unknown>;
  }

  if (!options.supportedSigningAlgs.includes(alg)) {
    throw new RequestObjectError(`unsupported request object signing alg: ${alg}`);
  }

  const jwks = options.jwks;
  if (!jwks || jwks.keys.length === 0) {
    throw new RequestObjectError('no JWKS registered to verify the request object signature');
  }

  const kid = typeof header['kid'] === 'string' ? (header['kid'] as string) : undefined;
  // ヘッダーに `kid` があれば `kid` が一致する鍵を、なければ登録されたすべての鍵を候補にする。
  // 鍵が `alg` を持つときは、その `alg` の署名の検証にだけ使う（RFC 7515 §4.1.1）。
  const candidates: Jwk[] = kid
    ? jwks.keys.filter((k) => k.kid === kid)
    : jwks.keys.slice();

  if (candidates.length === 0) {
    throw new RequestObjectError('no JWK matched the request object header (kid)');
  }

  const signingInput = `${headerB64}.${payloadB64}`;
  for (const jwk of candidates) {
    if (jwk.alg && jwk.alg !== alg) {
      continue;
    }
    let publicKey: CryptoKey;
    try {
      const algParams = extractAlgorithmParamsFromJwk(jwk);
      publicKey = await crypto.subtle.importKey('jwk', jwk, algParams, false, ['verify']);
    } catch {
      continue;
    }
    try {
      if (await verify(signingInput, signatureB64, publicKey)) {
        return payload as Record<string, unknown>;
      }
    } catch {
      // 次の候補の鍵を試す。
    }
  }

  throw new RequestObjectError('request object signature verification failed');
}
