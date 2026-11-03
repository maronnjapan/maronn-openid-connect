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
 * 鍵を読む前に、ヘッダーの `alg` を次の順で確かめる。
 * `requiredSigningAlg` があれば、それと一致しない `alg` を `none` も含めて最初に拒否する（OIDC Core 1.0 §6.3.2）。
 * 続いて、`none` を `allowUnsigned` が `true` のときだけ受け付け、`supportedSigningAlgs` にない `alg` を拒否する（RFC 8725 §3.2）。
 * 鍵は、これらの確認を通った後でだけ、`loadJwks` にヘッダーの `alg` と（あれば）`kid` を渡して読む。
 * そのため、受け付けないリクエストオブジェクトが `jwks_uri` への通信を起こすことはない。
 *
 * 署名の検証には、ヘッダーに `kid` があれば `kid` が一致する鍵を、なければ読んだすべての鍵を候補にする。
 * 候補のうち、`use` がないか `sig` で、使える `alg`（{@link resolveJwkSigningAlg}）がヘッダーの `alg` と同じ鍵だけを順に試す（RFC 8725 §3.1）。
 * 鍵はヘッダーの `alg` のとおりにインポートし（{@link importJwkForJwsVerification}）、2048 ビット未満の RSA 鍵（RFC 7518 §3.3）やインポートできない鍵は飛ばす。
 * どれか一つの鍵で署名を検証できれば、ペイロードを返す。
 *
 * 次のときは `RequestObjectError` を投げる:
 * - `request` が文字列でないか空のとき、または `.` で区切ったセグメントが三つでないとき（五つのセグメントからなる JWE も拒否する）。
 * - ヘッダーかペイロードを JSON オブジェクトとして復号できないとき、またはヘッダーに `alg` がないとき。
 * - `requiredSigningAlg` があり、ヘッダーの `alg` と一致しないとき。
 * - `alg` が `none` で、`allowUnsigned` が `false` のとき、または署名のセグメントが空でないとき。
 * - `alg` が `supportedSigningAlgs` にないとき、または `loadJwks` がないか、空の JWK Set を返したとき。
 * - `loadJwks` が `jwks_uri` の取得の失敗（`ClientJwksUriError`）を投げたとき。理由を含まない固定の文言にする。
 * - ヘッダーの `kid` と一致する鍵がないとき、ヘッダーの `alg` で使える鍵がないとき、またはどの鍵でも署名を検証できないとき。
 *
 * `loadJwks` が `ClientJwksUriError` 以外のエラーを投げたときは、そのまま投げる。
 *
 * @spec OIDC Core 1.0 §6.1 / §6.3.2
 * @spec RFC 8725 §3.1 / §3.2
 * @spec RFC 7518 §3.3
 * @throws {RequestObjectError} 形式が不正なとき、`alg` が登録した alg や受け付ける alg と合わないとき、鍵を読めないか見つからないとき、署名を検証できないとき
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

  // request_object_signing_alg を登録したクライアントのリクエストオブジェクトは、すべてその alg で署名されていなければならない
  // （OIDC Core 1.0 §6.3.2 / OIDC Dynamic Client Registration 1.0 §2）。そのため、`none` を見るより先に確かめる。
  if (options.requiredSigningAlg !== undefined && alg !== options.requiredSigningAlg) {
    throw new RequestObjectError(
      'request object alg does not match the registered request_object_signing_alg',
    );
  }

  if (alg === 'none') {
    if (!options.allowUnsigned) {
      throw new RequestObjectError('unsigned request object (alg=none) is not supported');
    }
    // `none` のアルゴリズムでは署名のセグメントが空になるので、空でなければ拒否する（RFC 7519 §6）。
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

  // ヘッダーに `kid` があれば `kid` が一致する鍵を、なければ読んだすべての鍵を候補にする。
  const keysOfKid: Jwk[] = kid === undefined ? jwks.keys.slice() : jwks.keys.filter((k) => k.kid === kid);
  if (keysOfKid.length === 0) {
    throw new RequestObjectError('no JWK matched the request object header (kid)');
  }

  // ヘッダーの `alg` は鍵を使うアルゴリズムと一致しなければならず、鍵は使える alg を一つに決めて使う（RFC 8725 §3.1、resolveJwkSigningAlg）。
  // `use` が `sig` 以外の鍵は、署名の検証に使わない（RFC 7517 §4.2）。
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
      // 2048 ビット未満の RSA 鍵（RFC 7518 §3.3）や、WebCrypto がインポートできない鍵は飛ばす。
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

/**
 * `loadJwks` にヘッダーの `alg` と（あれば）`kid` を渡して、署名の検証に使う鍵を読んで返す。
 *
 * `jwks_uri` の取得の失敗（`ClientJwksUriError`）は、理由を含まない固定の文言の `RequestObjectError` に変えて投げる。
 * 失敗の理由は OP の内側のネットワークを探る手がかりになるので、応答に出さない。
 * ほかのエラーはそのまま投げる。
 *
 * @throws {RequestObjectError} `loadJwks` が `ClientJwksUriError` を投げたとき
 */
async function loadVerificationKeys(
  loadJwks: NonNullable<ParseRequestObjectOptions['loadJwks']>,
  alg: string,
  kid: string | undefined,
): Promise<JwkSet> {
  try {
    return await loadJwks(kid === undefined ? { alg } : { alg, kid });
  } catch (e) {
    // クラスではなく形で見分ける。プロセスで共有するキャッシュは、別に読み込まれた core の複製が作ったものかもしれない（isClientJwksUriError）。
    if (isClientJwksUriError(e)) {
      throw new RequestObjectError('the client jwks_uri could not be retrieved');
    }
    throw e;
  }
}
