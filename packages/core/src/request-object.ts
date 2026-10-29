/**
 * Request Object (passed by value) processing.
 *
 * OIDC Core 1.0 §6.1: a Request Object is a JWT whose claims are the
 * Authorization Request parameters. When signed (JWS) it protects the integrity
 * of the request parameter values. This module parses the compact JWS, verifies
 * the signature against the client's registered keys, and returns the decoded
 * claim set so the caller can merge it into the Authorization Request.
 *
 * OIDC Core 1.0 §6.2: a Request Object may also be passed by reference, as the
 * request_uri parameter. validateRequestUri() checks the reference and its
 * registration (request_uris), and fetchRequestObjectByReference() retrieves
 * the Request Object, which is then verified exactly as one passed by value.
 */
import { verify, base64UrlToArrayBuffer, extractAlgorithmParamsFromJwk } from './crypto-utils.js';
import type { Jwk, JwkSet } from './jwks.js';
import { fetchTextWithLimits, LimitedFetchError, type LimitedFetchFailure } from './limited-fetch.js';
import { isLoopbackHostname } from './loopback.js';

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

// ---------------------------------------------------------------------------
// Request Object passed by reference (request_uri) — OIDC Core 1.0 §6.2
// ---------------------------------------------------------------------------

/**
 * `request_uri` の検査または取得に失敗したことを表すエラー。
 *
 * 呼び出し側（`resolveRequestObjectParams`）はこれを捕捉して
 * `invalid_request_uri`（OIDC Core 1.0 §3.1.2.6: "The request_uri in the
 * Authorization Request returns an error or contains invalid data"）の
 * `AuthorizationError` に変換する。取得した内容が Request Object として
 * 検証できない場合は `RequestObjectError`（`invalid_request_object`）になる。
 *
 * message は固定の ASCII 文言に限り、URL や取得した内容を反映しない。
 */
export class RequestUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestUriError';
  }
}

/**
 * OIDC Core 1.0 §6.2: "The entire Request URI SHOULD NOT exceed 512 ASCII
 * characters"。クライアント側の SHOULD だが、OP はこれを受理する上限として扱う。
 */
export const REQUEST_URI_MAX_LENGTH = 512;

/** 取得する Request Object の既定の上限（UTF-8 バイト）。 */
export const DEFAULT_REQUEST_OBJECT_MAX_BYTES = 16384;

/** `request_uri` の取得の既定のタイムアウト（ミリ秒）。 */
export const DEFAULT_REQUEST_URI_FETCH_TIMEOUT_MS = 5000;

/** `request_uri` の値に許す文字: 空白と制御文字を除く ASCII（RFC 3986 の URI 文字）。 */
const REQUEST_URI_CHARACTERS = /^[\x21-\x7e]+$/;

export interface ValidateRequestUriOptions {
  /**
   * クライアントが登録した `request_uris`（OIDC Dynamic Client Registration 1.0 §2）。
   * `requireRegistration` が true のとき、`request_uri` はこの一覧のいずれかと
   * フラグメントを含めて完全一致しなければならない。
   */
  registeredRequestUris?: readonly string[];
  /**
   * `require_request_uri_registration`（OIDC Discovery 1.0 §3）: 事前登録した
   * `request_uri` だけを受理するか。既定 true。false にすると、構文を満たす
   * どの URL でも取得しに行く（SSRF の面が開くので、信頼できる環境に限る）。
   */
  requireRegistration?: boolean;
}

/**
 * `request_uri` の値を検査する（OIDC Core 1.0 §6.2）。
 *
 * - 空白と制御文字を含まない ASCII の絶対 URL で、512 文字以内
 * - スキームは https（§6.2 MUST）。ループバックホスト（localhost / 127.0.0.0/8 /
 *   [::1]）の http は開発用に許す（redirect_uri と同じ規則）
 * - 資格情報（userinfo）を含まない
 * - `requireRegistration` のとき、登録した `request_uris` と完全一致する
 *
 * フラグメント（§6.2 が内容の SHA-256 ハッシュとして推奨するもの）は値の一部と
 * して照合し、取得時には送らない。
 *
 * @throws {RequestUriError} 検査に失敗した場合
 */
export function validateRequestUri(
  requestUri: unknown,
  options: ValidateRequestUriOptions = {},
): string {
  if (typeof requestUri !== 'string' || requestUri.length === 0) {
    throw new RequestUriError('request_uri must be a non-empty string');
  }
  if (requestUri.length > REQUEST_URI_MAX_LENGTH) {
    throw new RequestUriError('request_uri must not exceed 512 ASCII characters');
  }
  if (!REQUEST_URI_CHARACTERS.test(requestUri)) {
    throw new RequestUriError('request_uri must consist of visible ASCII characters');
  }
  let url: URL;
  try {
    url = new URL(requestUri);
  } catch {
    throw new RequestUriError('request_uri must be an absolute URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new RequestUriError('request_uri must use the https scheme');
  }
  if (url.username !== '' || url.password !== '') {
    throw new RequestUriError('request_uri must not carry credentials');
  }
  if ((options.requireRegistration ?? true) && !(options.registeredRequestUris ?? []).includes(requestUri)) {
    throw new RequestUriError('request_uri is not registered for this client');
  }
  return requestUri;
}

export interface FetchRequestObjectOptions {
  /** 取得に使う fetch。既定は globalThis.fetch。テストや独自の信頼設定のための注入点。 */
  fetch?: typeof fetch;
  /** 取得する内容の上限（UTF-8 バイト）。既定 {@link DEFAULT_REQUEST_OBJECT_MAX_BYTES}。 */
  maxBytes?: number;
  /** タイムアウト（ミリ秒）。既定 {@link DEFAULT_REQUEST_URI_FETCH_TIMEOUT_MS}。 */
  timeoutMs?: number;
}

/**
 * `request_uri` が参照する Request Object を取得する（OIDC Core 1.0 §6.2.3:
 * "the Authorization Server MUST send an HTTP GET request to the request_uri to
 * retrieve the referenced Request Object"）。
 *
 * - フラグメントは送らない（内容のハッシュであって、リソースの一部ではない）
 * - リダイレクトには従わない（登録した URL 以外へ辿らせない）
 * - 200 以外の応答、上限を超える内容、空の内容、ネットワークエラー、
 *   タイムアウトは {@link RequestUriError} になる
 *
 * 返す値は compact JWS の文字列（前後の空白を除いたもの）。検証は
 * {@link parseRequestObject} が by value と同じ規則で行う。内容の検査はしない
 * ので、取得した内容を信頼してはならない。
 *
 * @throws {RequestUriError} 取得に失敗した場合
 */
export async function fetchRequestObjectByReference(
  requestUri: string,
  options: FetchRequestObjectOptions = {},
): Promise<string> {
  const url = new URL(requestUri);
  url.hash = '';
  try {
    return await fetchTextWithLimits(url, {
      fetch: options.fetch,
      // RFC 9101 §4: application/oauth-authz-req+jwt; application/jwt and
      // application/jose are what servers commonly serve the JWT as.
      accept: 'application/oauth-authz-req+jwt, application/jwt, application/jose;q=0.9, text/plain;q=0.8, */*;q=0.5',
      maxBytes: options.maxBytes ?? DEFAULT_REQUEST_OBJECT_MAX_BYTES,
      timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_URI_FETCH_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof LimitedFetchError) {
      throw new RequestUriError(REQUEST_URI_FETCH_FAILURES[error.reason]);
    }
    throw error;
  }
}

/** The fixed description of each way the retrieval can fail. */
const REQUEST_URI_FETCH_FAILURES: Record<LimitedFetchFailure, string> = {
  network: 'request_uri could not be retrieved',
  status: 'request_uri did not return 200 OK',
  size: 'request_uri content exceeds the maximum size',
  empty: 'request_uri returned no content',
};
