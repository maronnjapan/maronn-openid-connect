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
 * 呼び出し側（`validateAuthorizationRequest`）はこれを捕捉して
 * `invalid_request`（OAuth 2.1 §4.1.2.1）の `AuthorizationError` に変換する。
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

function decodeJwtSegment(segment: string): unknown {
  const json = new TextDecoder().decode(base64UrlToArrayBuffer(segment));
  return JSON.parse(json);
}

/**
 * compact JWS としてシリアライズされた Request Object をパース・検証し、
 * payload（Authorization Request パラメータの JSON オブジェクト）を返す。
 *
 * - JWE（5 セグメント）や、3 セグメントでない壊れた compact 表現は拒否する。
 * - `alg: "none"` は `allowUnsigned` が true のときだけ受理し、署名部が空であることを要求する。
 * - 署名付きは `supportedSigningAlgs` に含まれる `alg` のみ受理し、
 *   JOSE header の `kid` で鍵を一意特定（無ければ `alg` 一致鍵を順次試行）して署名検証する。
 *
 * @throws {RequestObjectError} 構造不正・未対応 alg・鍵不一致・署名不一致など
 */
export async function parseRequestObject(
  request: string,
  options: ParseRequestObjectOptions,
): Promise<Record<string, unknown>> {
  if (typeof request !== 'string' || request.length === 0) {
    throw new RequestObjectError('request object is empty');
  }

  const parts = request.split('.');
  // OIDC Core §6.1: the Request Object is a JWT. We only accept JWS Compact
  // Serialization (3 segments). A JWE (5 segments) or any other shape is rejected.
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
    // RFC 7515 §6: the "none" algorithm uses an empty signature.
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
  // kid wins (unique key selection); otherwise try every registered key whose
  // advertised alg is compatible. RFC 7515 §4.1.1: a key pins its alg when present.
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
      // try next candidate key
    }
  }

  throw new RequestObjectError('request object signature verification failed');
}
