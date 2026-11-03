import { buildJoseHeader, signJwt } from './jwt.js';
import {
  verify,
  base64UrlToArrayBufferStrict,
  getJwaAlgorithm,
  extractAlgorithmParamsFromJwk,
} from './crypto-utils.js';
import type { Jwk, JwkSet } from './jwks.js';
import { isLoopbackHostname } from './loopback.js';

/**
 * ID Tokenのペイロード
 */
export interface IdTokenPayload {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  auth_time?: number;
  nonce?: string;
  acr?: string;
  amr?: string[];
  azp?: string;
  [key: string]: unknown;
}

/**
 * ID Token生成のオプション
 */
export interface GenerateIdTokenOptions {
  payload: IdTokenPayload;
  privateKey: CryptoKey;
  keyId?: string;
}



/**
 * `iss` を発行者の URL として検証する。
 *
 * 次のどれかに当てはまれば `Error` を投げる。
 * - URL として解析できない
 * - スキームが `https` でない（開発用に、ループバックのホストの `localhost`、`127.` で始まる IPv4 アドレス、`[::1]` は除く）
 * - クエリを含む
 * - フラグメントを含む
 *
 * @throws {Error} 上のどれかに当てはまるとき
 */
function validateIssuer(iss: string): void {
  // URL として解析できなければ、`new URL()` の `TypeError` をこのライブラリの `Error` に置き換えて投げる（RFC 7519 §2 の StringOrURI）。
  // URL でない発行者に対して、呼び出し側が常に同じ形の失敗を受け取れるようにする。
  let url: URL;
  try {
    url = new URL(iss);
  } catch {
    throw new Error('Issuer must be a valid URL');
  }

  // スキームが `https` でなければ例外を投げる（開発で使うループバックのホストは除く）。
  if (url.protocol !== 'https:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('Issuer must use https scheme (except for loopback hosts)');
  }

  // クエリを含んでいれば例外を投げる。
  if (url.search) {
    throw new Error('Issuer must not contain query parameters');
  }

  // フラグメントを含んでいれば例外を投げる。
  if (url.hash) {
    throw new Error('Issuer must not contain fragment');
  }
}

/**
 * Clock Skew 許容の既定値（秒）。
 *
 * RFC 8725 §3.8: 検証側は `iat` / `exp` / `nbf` を厳格に確認すべきで、leeway は
 * 数分以内に留める。通常は 30〜60 秒が妥当で、5 分（300 秒）を超える設定は推奨しない。
 * https://datatracker.ietf.org/doc/html/rfc8725#section-3.8
 */
export const DEFAULT_CLOCK_SKEW_TOLERANCE_SEC = 60;

/**
 * 発行する ID トークンのペイロードを検証する。
 *
 * 次のどれかに当てはまれば `Error` を投げる。
 * - `iss` がないか、発行者の URL の条件を満たさない（{@link validateIdTokenIssuer}）
 * - `sub` がないか、255 文字を超える
 * - `aud` がない、空の配列である、または配列に空文字列や文字列でない値を含む
 * - `exp` がない、数値でない、または現在時刻から許すずれを引いた時刻より前である（{@link validateIdTokenExpiration}）
 * - `iat` がないか、数値でない
 * - `aud` が複数の値を持つのに、`azp` がないか `aud` のどれとも一致しない（{@link validateIdTokenAuthorizedParty}）
 *
 * `exp` と `iat` を数値に限る検証は、受け取った ID トークンを検証する {@link validateIdTokenHint} と同じ厳しさにしてある。
 *
 * @param payload 検証する ID トークンのペイロード
 * @param options.clockSkewToleranceSec `exp` が過去かを判定するときに許す時刻のずれ（秒）。
 *   既定は {@link DEFAULT_CLOCK_SKEW_TOLERANCE_SEC} である。
 *   RFC 8725 §3.8 に従い、通常は 30〜60 秒にし、5 分を超える値は推奨しない。
 * @throws {Error} 上のどれかに当てはまるとき
 */
export function validatePayload(
  payload: IdTokenPayload,
  options?: { clockSkewToleranceSec?: number },
): void {
  // 必須のクレームを順に検証する。
  // 最初に、`iss` があり、発行者の URL の条件を満たすことを確かめる。
  validateIdTokenIssuer(payload.iss);

  if (!payload.sub) {
    throw new Error('Missing required claim: sub');
  }

  // `sub` が 255 文字を超えていれば例外を投げる（OIDC Core 1.0 §2 は 255 文字以下の ASCII と定める）。
  if (payload.sub.length > 255) {
    throw new Error('Subject identifier must not exceed 255 ASCII characters');
  }

  if (payload.aud === undefined || payload.aud === null) {
    throw new Error('Missing required claim: aud');
  }

  // `aud` が空の配列なら例外を投げる。
  if (Array.isArray(payload.aud) && payload.aud.length === 0) {
    throw new Error('Audience must not be an empty array');
  }

  // `aud` の配列に空文字列や文字列でない値があれば例外を投げる（RFC 7519 §4.1.3）。
  // `aud` は StringOrURI かその配列なので、構造の正しくないオーディエンスを持つ ID トークンを発行しないようにする。
  if (Array.isArray(payload.aud)) {
    for (const a of payload.aud) {
      if (typeof a !== 'string' || a.length === 0) {
        throw new Error('Audience array must contain only non-empty strings');
      }
    }
  }

  const leeway = options?.clockSkewToleranceSec ?? DEFAULT_CLOCK_SKEW_TOLERANCE_SEC;
  validateIdTokenExpiration(payload.exp, Math.floor(Date.now() / 1000), leeway);

  if (payload.iat === undefined || payload.iat === null) {
    throw new Error('Missing required claim: iat');
  }

  // `iat` が数値でなければ例外を投げる（RFC 7519 §4.1.6 では `iat` は NumericDate）。
  // `validateIdTokenHint()` と同じ厳しさにする。
  if (typeof payload.iat !== 'number') {
    throw new Error('iat must be a number (NumericDate)');
  }

  validateIdTokenAuthorizedParty(payload.aud, payload.azp);
}

/**
 * `iss` が発行者の URL の条件を満たすか検証する。
 *
 * 発行者は、クエリとフラグメントを含まない `https` の URL でなければならない（OIDC Core 1.0 §2）。
 * ループバックのホスト（`localhost`、`127.` で始まる IPv4 アドレス、`[::1]`）に限り、`https` 以外のスキームも受け付ける。
 *
 * @spec OIDC Core 1.0 §2
 * @throws {Error} `iss` がないとき、URL として解析できないとき、スキームが条件に合わないとき、またはクエリかフラグメントを含むとき
 */
export function validateIdTokenIssuer(issuer: string | undefined): void {
  if (!issuer) {
    throw new Error('Missing required claim: iss');
  }
  validateIssuer(issuer);
}

/**
 * ID トークンの `exp` が過ぎていないかを検証する。
 *
 * `exp` が `now` から `leeway` を引いた時刻より前なら、期限切れとして拒否する。
 * `now` と `leeway` の単位は秒である。
 * `exp` を数値に限るのは、RFC 7519 §4.1.4 が `exp` を NumericDate と定めるためである。
 *
 * @spec RFC 7519 §4.1.4
 * @throws {Error} `exp` がないとき、数値でないとき、または期限切れのとき
 */
export function validateIdTokenExpiration(expiration: unknown, now: number, leeway: number): void {
  if (expiration === undefined || expiration === null) {
    throw new Error('Missing required claim: exp');
  }

  // `exp` が数値でなければ例外を投げる（RFC 7519 §4.1.4 では `exp` は NumericDate）。
  // 発行するペイロードの `exp` も、`validateIdTokenHint()` の `typeof === 'number'` の確認と同じく数値に限る。
  if (typeof expiration !== 'number') {
    throw new Error('exp must be a number (NumericDate)');
  }

  if (expiration < now - leeway) {
    throw new Error('Token expiration time is in the past');
  }
}

/**
 * `aud` が複数なら、`azp` がその一つかを検証する。
 *
 * `aud` が複数の値を持つときは、`azp` があり、`aud` の値のどれかと一致しなければならない（OIDC Core 1.0 §2、§3.1.3.7）。
 * `aud` が文字列か要素が 1 つの配列なら、何も確かめない。
 *
 * @spec OIDC Core 1.0 §2
 * @spec OIDC Core 1.0 §3.1.3.7
 * @throws {Error} `aud` が複数の値を持つのに、`azp` がないとき、または `azp` が `aud` のどれとも一致しないとき
 */
export function validateIdTokenAuthorizedParty(
  audience: string | readonly string[],
  authorizedParty: string | undefined,
): void {
  // 発行する側（`token-response.ts` の `buildIdTokenAudience()`）は、既定ではオーディエンスを 1 つにし、`aud` をクライアント ID にして `azp` を付けない。
  // 追加のオーディエンスを設定したときは、`aud` を `[クライアント ID, ...]` の配列にし、`azp` をクライアント ID にする。
  // この検証は、自分で発行するトークンにも、外部から受け取る複数のオーディエンスを持ちうる ID トークン（`id_token_hint` や連携先のトークン）にも、同じ規則を当てはめる。
  if (Array.isArray(audience) && audience.length > 1) {
    if (!authorizedParty) {
      throw new Error('azp is required when aud contains multiple values');
    }

    // `azp` が `aud` の値のどれとも一致しなければ例外を投げる。
    if (!audience.includes(authorizedParty)) {
      throw new Error('azp must be one of the audience values');
    }
  }
}

/**
 * ペイロードを検証して署名し、ID トークンの JWT を返す。
 *
 * ペイロードは {@link validatePayload} で検証し、不備があれば署名せずに例外を投げる。
 * JOSE ヘッダーには、秘密鍵のアルゴリズムから求めた `alg` と `typ: "JWT"` を入れ、`keyId` を指定したときは `kid` も入れる。
 *
 * 使える署名アルゴリズムと、対応する暗号方式は次のとおりである。
 * - RS256、RS384、RS512: RSASSA-PKCS1-v1_5 と SHA-256、SHA-384、SHA-512
 * - ES256、ES384、ES512: ECDSA と P-256、P-384、P-521（ハッシュ関数は SHA-256、SHA-384、SHA-512）
 *
 * RS256 は、OpenID Connect Core 1.0 で既定とされるアルゴリズムである（SHOULD）。
 * ES256、ES384、ES512 は楕円曲線暗号による高速で安全な署名方式なので、こちらを推奨する。
 *
 * @param options ペイロード、署名に使う秘密鍵、ヘッダーの `kid` にする鍵 ID
 * @returns ID トークン（JWS のコンパクト形式の JWT）
 * @throws {Error} ペイロードが検証を通らないとき、または秘密鍵のアルゴリズムが RSASSA-PKCS1-v1_5 でも ECDSA でもないとき
 */
export async function generateIdToken(options: GenerateIdTokenOptions): Promise<string> {
  const { payload, privateKey, keyId } = options;

  // ペイロードを検証し、不備があれば例外を投げる。
  validatePayload(payload);

  // 秘密鍵のアルゴリズムから `alg` を求め、JOSE ヘッダーを作る。
  const header = buildJoseHeader(getJwaAlgorithm(privateKey), 'JWT', keyId);

  return signJwt(header, payload, privateKey);
}

/**
 * id_token_hint 検証エラー
 *
 * OIDC Core 1.0 §3.1.2.1 / §3.1.2.6: id_token_hint が無効な場合、prompt=none との
 * 組み合わせで `login_required` を返す必要がある。呼び出し側がそのまま AS エラーに
 * 写像できるよう、`error` プロパティに OAuth エラーコードを保持する。
 */
export class IdTokenHintError extends Error {
  public readonly error: 'login_required';

  constructor(message: string) {
    super(message);
    this.name = 'IdTokenHintError';
    this.error = 'login_required';
  }
}

/**
 * RFC 7515 が「鍵を外部から取得するための情報源」として定義する JOSE Header フィールド。
 * 本リポジトリは事前登録済み JWKS のみで鍵を選ぶため、これらが受信 JWS に含まれていたら
 * 即拒否する（RFC 8725 §3.1 / OIDC Core §16.18: SSRF・任意公開鍵差し替え・Cross-JWT confusion 対策）。
 * - jku: RFC 7515 §4.1.2 / jwk: §4.1.3 / x5u: §4.1.5 / x5c: §4.1.6
 */
const FORBIDDEN_KEY_HEADERS = ['jku', 'x5u', 'jwk', 'x5c'] as const;

/**
 * 外部の鍵を指すヘッダーを含む JWS を拒否する。
 *
 * 受け取った JWS の JOSE ヘッダーに `jku`、`x5u`、`jwk`、`x5c` のどれかがあれば、`IdTokenHintError` を投げる。
 * これらは鍵を外部から取得するための情報で、この OP は事前に登録された JWK Set だけから鍵を選ぶ。
 * `logout_token` やリクエストオブジェクトなど、今後追加する JWS の受信処理でも使えるように、小さな関数として切り出している。
 *
 * @throws {IdTokenHintError} `login_required`: ヘッダーに `jku`、`x5u`、`jwk`、`x5c` のどれかがあるとき
 */
function assertNoExternalKeyHeaders(header: Record<string, unknown>): void {
  for (const field of FORBIDDEN_KEY_HEADERS) {
    if (field in header) {
      throw new IdTokenHintError(
        `id_token_hint JOSE header contains unsupported field: ${field}`,
      );
    }
  }
}

/**
 * `id_token_hint` を検証し、ペイロードを返す。
 *
 * `id_token_hint` を受け取った OP は、署名、`iss`、`aud`、`exp` を検証してから `sub` を信頼してよい（OIDC Core 1.0 §3.1.2.1）。
 * この関数は、JWS を分解し、JWK Set から鍵を選んで署名を検証してから、クレームを検証する。
 * 検証に失敗すると `IdTokenHintError` を投げるので、呼び出し側はそのまま `login_required` のエラーとして返せる。
 *
 * 鍵は次のように選ぶ。
 * - JOSE ヘッダーに `kid` があれば、同じ `kid` の鍵だけを候補にする
 * - `kid` がなければ、`alg` がヘッダーと一致する鍵をすべて候補にする
 * - 候補を順に試し、どれか一つで署名を検証できれば通す（`alg` がヘッダーと違う鍵は使わない）
 *
 * クレームは次のことを確かめる。
 * - `iss` が `expectedIss` と一致する
 * - `aud` が `expectedAud` を含む
 * - `exp` に許すずれを足した時刻が、現在時刻より前でない
 * - `iat` が、現在時刻に許すずれを足した時刻より後でない
 * - `sub` が空でない文字列である
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 * @param hint `id_token_hint` パラメータの値（JWS のコンパクト形式の JWT）
 * @param options 期待する `iss` と `aud`、検証に使う JWK Set
 * @param verifyOptions.clockSkewToleranceSec `exp` が過去か、`iat` が未来かを判定するときに許す時刻のずれ（秒）。
 *   既定は {@link DEFAULT_CLOCK_SKEW_TOLERANCE_SEC} である。
 *   RFC 8725 §3.8 に従い、通常は 30〜60 秒にし、5 分を超える値は推奨しない。
 * @returns 検証を通った ID トークンのペイロード（少なくとも `sub` を含む）
 * @throws {IdTokenHintError} `login_required`: どれかの検証に失敗したとき
 */
export async function validateIdTokenHint(
  hint: string,
  options: {
    expectedIss: string;
    expectedAud: string;
    jwks: JwkSet;
  },
  verifyOptions?: { clockSkewToleranceSec?: number },
): Promise<{ sub: string; [key: string]: unknown }> {
  const { expectedIss, expectedAud, jwks } = options;
  const leeway = verifyOptions?.clockSkewToleranceSec ?? DEFAULT_CLOCK_SKEW_TOLERANCE_SEC;

  const { header, payload, signingInput, signature } = decodeIdTokenHint(hint);
  const { algorithm, keyId } = validateIdTokenHintHeader(header);
  const candidates = selectIdTokenHintKeys(jwks.keys, algorithm, keyId);
  await verifyIdTokenHintSignature(signingInput, signature, candidates, algorithm);

  validateIdTokenHintIssuer(payload['iss'], expectedIss);
  validateIdTokenHintAudience(payload['aud'], expectedAud);
  const now = Math.floor(Date.now() / 1000);
  validateIdTokenHintExpiration(payload['exp'], now, leeway);
  validateIdTokenHintIssuedAt(payload['iat'], now, leeway);
  requireIdTokenHintSubject(payload['sub']);

  return payload as { sub: string; [key: string]: unknown };
}

/** {@link decodeIdTokenHint} の戻り値。署名を検証していないため、どのクレームも信頼できない。 */
export interface DecodedIdTokenHint {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: string;
}

/**
 * `id_token_hint` を分解し、ヘッダーとペイロードを返す。
 *
 * JWS のコンパクト形式を `.` で 3 つに分け、ヘッダーとペイロードを base64url として厳密に復号してから JSON として解析する（{@link base64UrlToArrayBufferStrict}）。
 * 署名入力（ヘッダーとペイロードを `.` でつないだ文字列）と署名も一緒に返す。
 * 署名、発行者、有効期限は検証しないので、返す値のどのクレームもまだ信頼できない。
 *
 * @throws {IdTokenHintError} `login_required`: 値が空のとき、`.` で 3 つに分かれないとき、またはヘッダーかペイロードを base64url の JSON として読めないとき
 */
export function decodeIdTokenHint(hint: string): DecodedIdTokenHint {
  if (typeof hint !== 'string' || hint.length === 0) {
    throw new IdTokenHintError('id_token_hint is empty');
  }

  const parts = hint.split('.');
  if (parts.length !== 3) {
    throw new IdTokenHintError('id_token_hint is not a valid JWS compact serialization');
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToArrayBufferStrict(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlToArrayBufferStrict(payloadB64)));
  } catch {
    throw new IdTokenHintError('id_token_hint header or payload is not valid base64url JSON');
  }

  return { header, payload, signingInput: `${headerB64}.${payloadB64}`, signature: signatureB64 };
}

/**
 * ヘッダーを検証し、`alg` と `kid` を返す。
 *
 * `id_token_hint` のヘッダーが署名を示し（`alg` が空でない文字列で、`none` でない）、外部の鍵を参照しないことを確かめる（RFC 8725 §3.1）。
 * `kid` が文字列でなければ、`kid` には `undefined` を返す。
 *
 * @spec RFC 8725 §3.1
 * @throws {IdTokenHintError} `login_required`: `alg` がないか `none` のとき、またはヘッダーに `jku`、`x5u`、`jwk`、`x5c` のどれかがあるとき
 */
export function validateIdTokenHintHeader(
  header: Record<string, unknown>,
): { algorithm: string; keyId: string | undefined } {
  const headerAlg = typeof header['alg'] === 'string' ? (header['alg'] as string) : undefined;
  if (!headerAlg || headerAlg === 'none') {
    throw new IdTokenHintError('id_token_hint alg is missing or "none"');
  }
  // 外部から鍵を取得するためのヘッダー（`jku`、`x5u`、`jwk`、`x5c`）があれば拒否する（RFC 8725 §3.1、OIDC Core 1.0 §16.18）。
  assertNoExternalKeyHeaders(header);
  const headerKid = typeof header['kid'] === 'string' ? (header['kid'] as string) : undefined;
  return { algorithm: headerAlg, keyId: headerKid };
}

/**
 * ヘッダーの `kid` か `alg` に合う鍵の一覧を返す。
 *
 * `keyId` があれば `kid` が同じ鍵を、なければ `alg` が `algorithm` と同じ鍵を、登録済みの鍵から選ぶ。
 * `keyId` で選んだ鍵の `alg` がヘッダーと一致するかは、{@link verifyIdTokenHintSignature} が確かめる。
 *
 * @throws {IdTokenHintError} `login_required`: 合う鍵が 1 つもないとき
 */
export function selectIdTokenHintKeys<Key extends Pick<Jwk, 'alg' | 'kid'>>(
  keys: readonly Key[],
  algorithm: string,
  keyId?: string,
): Key[] {
  const candidates = keyId
    ? keys.filter((k) => k.kid === keyId)
    : keys.filter((k) => k.alg === algorithm);

  if (candidates.length === 0) {
    throw new IdTokenHintError('No JWK matched the id_token_hint header');
  }
  return candidates;
}

/**
 * 候補の鍵を順に試し、署名を検証する。
 *
 * どれか一つの鍵で署名を検証できれば返り、どの鍵でも検証できなければ `IdTokenHintError` を投げる。
 * `alg` が `algorithm` と違う鍵（`alg` のない鍵を含む）と、読み込めない鍵は飛ばす（RFC 7515 §4.1.1）。
 *
 * @spec RFC 7515 §4.1.1
 * @throws {IdTokenHintError} `login_required`: どの候補の鍵でも署名を検証できないとき
 */
export async function verifyIdTokenHintSignature(
  signingInput: string,
  signature: string,
  candidates: readonly Jwk[],
  algorithm: string,
): Promise<void> {
  for (const jwk of candidates) {
    if (jwk.alg !== algorithm) {
      // 鍵の `alg` がヘッダーの `alg` と違えば、検証せずにこの鍵を飛ばす（RFC 7515 §4.1.1）。
      // 1 つの鍵には 1 つのアルゴリズムだけを使う。
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
      if (await verify(signingInput, signature, publicKey)) {
        return;
      }
    } catch {
      // 検証で例外が起きた鍵も飛ばし、次の候補を試す。
    }
  }
  throw new IdTokenHintError('id_token_hint signature verification failed');
}

/**
 * `iss` が期待する発行者と一致するかを検証する。
 *
 * `id_token_hint` の署名を検証した後に呼ぶ。
 *
 * @throws {IdTokenHintError} `login_required`: `iss` が `expectedIssuer` と一致しないとき
 */
export function validateIdTokenHintIssuer(issuer: unknown, expectedIssuer: string): void {
  if (issuer !== expectedIssuer) {
    throw new IdTokenHintError('id_token_hint iss does not match expected issuer');
  }
}

/**
 * `aud` が期待するオーディエンスを含むかを検証する。
 *
 * `id_token_hint` の `aud` は文字列か配列で、文字列なら一致すること、配列なら要素に含むことを確かめる（OIDC Core 1.0 §2）。
 *
 * @spec OIDC Core 1.0 §2
 * @throws {IdTokenHintError} `login_required`: `aud` が `expectedAudience` を含まないとき
 */
export function validateIdTokenHintAudience(audience: unknown, expectedAudience: string): void {
  const matches = audience === expectedAudience ||
    (Array.isArray(audience) && audience.includes(expectedAudience));
  if (!matches) {
    throw new IdTokenHintError('id_token_hint aud does not match expected audience');
  }
}

/**
 * `exp` が数値で、期限切れでないことを検証する。
 *
 * `id_token_hint` の `exp` に `leeway` を足した時刻が `now` より前なら、期限切れとして拒否する。
 * 時刻の単位は秒である。
 *
 * @throws {IdTokenHintError} `login_required`: `exp` が数値でないとき、または期限切れのとき
 */
export function validateIdTokenHintExpiration(expiration: unknown, now: number, leeway: number): void {
  if (typeof expiration !== 'number') {
    throw new IdTokenHintError('id_token_hint is missing exp claim');
  }
  if (expiration + leeway < now) {
    throw new IdTokenHintError('id_token_hint has expired');
  }
}

/**
 * `iat` が数値で、未来の時刻でないことを検証する。
 *
 * `id_token_hint` の `iat` が `now` に `leeway` を足した時刻より後なら、未来に発行されたものとして拒否する（RFC 8725 §3.8）。
 * 時刻の単位は秒である。
 *
 * @spec RFC 8725 §3.8
 * @throws {IdTokenHintError} `login_required`: `iat` が数値でないとき、または未来の時刻のとき
 */
export function validateIdTokenHintIssuedAt(issuedAt: unknown, now: number, leeway: number): void {
  if (typeof issuedAt !== 'number') {
    throw new IdTokenHintError('id_token_hint is missing iat claim');
  }
  if (issuedAt > now + leeway) {
    throw new IdTokenHintError('id_token_hint iat is in the future');
  }
}

/**
 * `sub` が空でない文字列ならそのまま返す。
 *
 * `id_token_hint` のほかのすべての検証を通した後に使う。
 *
 * @throws {IdTokenHintError} `login_required`: `sub` が文字列でないか、空文字列のとき
 */
export function requireIdTokenHintSubject(subject: unknown): string {
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new IdTokenHintError('id_token_hint is missing sub claim');
  }
  return subject;
}
