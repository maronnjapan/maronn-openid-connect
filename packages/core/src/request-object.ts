/**
 * Request Object (passed by value) processing.
 *
 * OIDC Core 1.0 §6.1: a Request Object is a JWT whose claims are the
 * Authorization Request parameters. When signed (JWS) it protects the integrity
 * of the request parameter values. This module parses the compact JWS, verifies
 * the signature against the client's registered keys, and returns the decoded
 * claim set so the caller can merge it into the Authorization Request.
 */
import { isClientJwksUriError } from './client-jwks-uri.js';
import {
  base64UrlToArrayBuffer,
  importJwkForJwsVerification,
  resolveJwkSigningAlg,
  verify,
} from './crypto-utils.js';
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
   * 署名検証に使う、クライアントが登録した公開鍵（JWK Set）を読む。署名付き
   * （`alg !== "none"`）Request Object の検証に必須で、無ければ署名付き Request Object を拒否する。
   *
   * 登録した alg との不一致、`alg: "none"`、受け付けない alg、壊れた JWT を拒否した後でだけ
   * 呼ぶので、`jwks_uri` からの取得のような外部への読み込みは、受け付ける alg で署名された
   * Request Object が届いたときにだけ起きる。`kid` はヘッダーにあるときだけ渡す
   * （OIDC Core 1.0 §10.1.1: 見慣れない kid は鍵を取り直す合図になる）。
   * 値で持つ鍵は `async () => jwks` で渡す。
   * `ClientJwksUriError` を投げると、理由を応答に出さない固定文言の `RequestObjectError` になる。
   */
  loadJwks?: (header: { alg: string; kid?: string }) => Promise<JwkSet>;
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
  /**
   * クライアントが登録した `request_object_signing_alg`（OIDC Dynamic Client Registration 1.0 §2）。
   *
   * あれば、ヘッダーの `alg` が一致しない Request Object をほかのどの検査よりも先に拒否する
   * （OIDC Core 1.0 §6.3.2 MUST）。`none` を登録したクライアントの署名無し Request Object は、
   * `allowUnsigned` が true のときだけ受理する。
   */
  requiredSigningAlg?: string;
}

function decodeJwtSegment(segment: string): unknown {
  const json = new TextDecoder().decode(base64UrlToArrayBuffer(segment));
  return JSON.parse(json);
}

/**
 * compact JWS としてシリアライズされた Request Object をパース・検証し、
 * payload（Authorization Request パラメータの JSON オブジェクト）を返す。
 *
 * 次の順で判定する。
 *
 * 1. 構造（JWE（5 セグメント）や、3 セグメントでない壊れた compact 表現は拒否する）、
 *    ヘッダー、ペイロード、`alg` の有無を検査する
 * 2. `requiredSigningAlg` があり、ヘッダーの `alg` と違えば拒否する（`none` も含む。
 *    OIDC Core 1.0 §6.3.2）
 * 3. `alg: "none"` は `allowUnsigned` が true のときだけ受理し、署名部が空であることを要求する
 * 4. `supportedSigningAlgs` に無い `alg` を拒否する（RFC 8725 §3.2）
 * 5. `loadJwks` で鍵を読む（無ければ署名付き Request Object を拒否する）
 * 6. `kid` があれば一致する鍵に絞り、その中から `use` が無いか `sig` で、使える alg
 *    （{@link resolveJwkSigningAlg}）がヘッダーの `alg` と同じ鍵だけを候補にする（RFC 8725 §3.1）
 * 7. 候補を `alg` のとおりに import して（{@link importJwkForJwsVerification}。2048 ビット未満の
 *    RSA 鍵は使わない。RFC 7518 §3.3）、署名を検証する
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

  // OIDC Core 1.0 §6.3.2 / OIDC Dynamic Client Registration 1.0 §2: every Request
  // Object of a client that registered request_object_signing_alg MUST be signed
  // with it, so this check comes before alg=none is even considered.
  if (options.requiredSigningAlg !== undefined && alg !== options.requiredSigningAlg) {
    throw new RequestObjectError(
      'request object alg does not match the registered request_object_signing_alg',
    );
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

  const kid = typeof header['kid'] === 'string' ? (header['kid'] as string) : undefined;

  const jwks = options.loadJwks ? await loadVerificationKeys(options.loadJwks, alg, kid) : undefined;
  if (!jwks || jwks.keys.length === 0) {
    throw new RequestObjectError('no JWKS registered to verify the request object signature');
  }

  // kid wins (unique key selection); otherwise try every registered key.
  const keysOfKid: Jwk[] = kid === undefined ? jwks.keys.slice() : jwks.keys.filter((k) => k.kid === kid);
  if (keysOfKid.length === 0) {
    throw new RequestObjectError('no JWK matched the request object header (kid)');
  }

  // RFC 8725 §3.1: the alg of the header MUST be the algorithm the key is used
  // with, and each key is used with exactly one algorithm (resolveJwkSigningAlg).
  // RFC 7517 §4.2: a key published for another use than sig does not verify.
  const candidates = keysOfKid.filter(
    (jwk) => (jwk.use === undefined || jwk.use === 'sig') && resolveJwkSigningAlg(jwk) === alg,
  );
  if (candidates.length === 0) {
    throw new RequestObjectError('no signing JWK matched the request object header (alg)');
  }

  const signingInput = `${headerB64}.${payloadB64}`;
  for (const jwk of candidates) {
    let publicKey: CryptoKey;
    try {
      publicKey = await importJwkForJwsVerification(jwk, alg);
    } catch {
      // An RSA key under 2048 bits (RFC 7518 §3.3) or a key WebCrypto refuses.
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

/**
 * loadJwks で鍵を読む。jwks_uri の取得の失敗（ClientJwksUriError）は理由を応答に出さない
 * 固定文言の RequestObjectError に変え（失敗の理由は内部ネットワークを探る手がかりになる）、
 * ほかのエラーはそのまま投げる。
 */
async function loadVerificationKeys(
  loadJwks: NonNullable<ParseRequestObjectOptions['loadJwks']>,
  alg: string,
  kid: string | undefined,
): Promise<JwkSet> {
  try {
    return await loadJwks(kid === undefined ? { alg } : { alg, kid });
  } catch (e) {
    // Told apart by shape, not by class: a cache shared by the process may come
    // from another copy of core (isClientJwksUriError).
    if (isClientJwksUriError(e)) {
      throw new RequestObjectError('the client jwks_uri could not be retrieved');
    }
    throw e;
  }
}
