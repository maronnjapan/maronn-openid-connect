/**
 * private_key_jwt のクライアントアサーション検証
 * OIDC Core 1.0 §9 / RFC 7523 §3 / RFC 7521 §4.2
 *
 * クライアントは自分の秘密鍵で署名した JWT を `client_assertion` として送り、
 * OP はクライアントが private_key_jwt の用途に登録した公開鍵で署名とクレームを検証する。
 * 鍵は登録済みの JWK Set からだけ選び、JWT のヘッダー（jku / jwk など）からは取らない。
 *
 * どのステップも鍵の取得や保存には触れない。登録鍵の読み出しと jti の記録は
 * 呼び出し側（CLI 生成コード）が resolver とストアで行い、ここには値だけを渡す。
 */
import type { webcrypto } from 'node:crypto';
import { base64UrlToArrayBufferStrict, rsaModulusBitLength, verify } from './crypto-utils.js';
import type { Jwk, JwkSet } from './jwks.js';
import { TokenError, TokenErrorCode } from './token-error.js';

/** RFC 7523 §2.2: JWT によるクライアント認証の `client_assertion_type`。 */
export const CLIENT_ASSERTION_TYPE_JWT_BEARER =
  'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/**
 * core が検証できるクライアントアサーションの JWS alg（RSASSA-PKCS1-v1_5 と ECDSA）。
 * OIDC Core 1.0 §9 の private_key_jwt は非対称鍵の署名なので、`none` と
 * client_secret_jwt 用の HMAC（HS256 など）は含めない。
 */
export const DEFAULT_CLIENT_ASSERTION_SIGNING_ALGS: readonly string[] = [
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
  'ES512',
];

/** RFC 8725 §3.8: clock skew の許容は数分以内に留める。ID Token の検証と同じ 60 秒。 */
export const DEFAULT_CLIENT_ASSERTION_CLOCK_SKEW_SEC = 60;

/**
 * RFC 8725 §3.1: 鍵を JWT 側から指定する JOSE Header。登録済みの鍵だけで検証するので拒否する。
 * crit（RFC 7515 §4.1.11）は理解できない拡張を示すため、これも拒否する。
 */
const FORBIDDEN_HEADER_FIELDS = ['jku', 'jwk', 'x5u', 'x5c', 'crit'] as const;

/**
 * 受け付ける `typ`。draft-ietf-oauth-rfc7523bis は `client-authentication+jwt` を推奨し、
 * RFC 7519 §5.1 の `JWT` も JWT である。Request Object（`oauth-authz-req+jwt`）など
 * 別の用途の JWT をクライアント認証に使わせないため、それ以外は拒否する（RFC 8725 §3.11）。
 */
const ACCEPTED_TYPES = ['client-authentication+jwt', 'jwt'];

/** RFC 7518 §3.3: RS256 などには 2048 ビット以上の鍵を使わなければならない。 */
const MIN_RSA_MODULUS_BITS = 2048;

/** {@link decodeClientAssertion} の戻り値。署名を検証していないため、どの値も信頼できない。 */
export interface DecodedClientAssertion {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: string;
}

/** {@link verifyClientAssertion} のオプション。 */
export interface VerifyClientAssertionOptions {
  /** 認証するクライアントの client_id。アサーションの iss と sub はこれと一致しなければならない。 */
  clientId: string;
  /**
   * クライアントが private_key_jwt の用途に登録した公開鍵（ClientKeyResolver の
   * `findClientKeys(clientId, 'private_key_jwt')`）。無ければ必ず拒否する。
   */
  jwks: JwkSet | undefined;
  /**
   * aud として受け付ける値。aud の各値がこのどれかでなければ拒否する。
   * OIDC Core 1.0 §9 はトークンエンドポイントの URL を、draft-ietf-oauth-rfc7523bis は
   * issuer identifier だけを使うよう求める。issuer だけを渡すと後者に従う。
   */
  audiences: readonly string[];
  /** 受け付ける JWS alg。既定は {@link DEFAULT_CLIENT_ASSERTION_SIGNING_ALGS}。 */
  supportedSigningAlgs?: readonly string[];
  /** 現在時刻（エポック秒）。既定は `Date.now()` から求める。 */
  now?: number;
  /** exp / nbf / iat の許容誤差（秒）。既定は {@link DEFAULT_CLIENT_ASSERTION_CLOCK_SKEW_SEC}。 */
  clockSkewToleranceSec?: number;
}

/** 検証を通ったアサーションの jti と期限。jti の再利用検知（{@link rejectReplayedClientAssertion}）に渡す。 */
export interface VerifiedClientAssertion {
  jti: string;
  /**
   * このアサーションを受け付ける最後の時刻（エポック秒）。exp に clock skew の許容を足した値で、
   * jti はこの時刻まで覚えておかなければならない。
   */
  expiresAt: number;
}

/**
 * 使用済みのクライアントアサーションの jti を記録するストア。
 *
 * OIDC Core 1.0 §9: クライアントアサーションは一度しか使ってはならない。
 * `markUsed` は同じクライアントの同じ jti がまだ記録されていなければ記録して `true` を、
 * すでに記録されていれば `false` を返す。確認と記録は 1 回の不可分な操作で行うこと
 * （SQL の `INSERT ... ON CONFLICT DO NOTHING`、KV の set-if-absent など）。
 * 記録は `expiresAt`（エポック秒）を過ぎれば消してよい。
 */
export interface ClientAssertionJtiStore {
  markUsed(entry: { clientId: string; jti: string; expiresAt: number }): Promise<boolean>;
}

/**
 * private_key_jwt のクライアントアサーションを検証し、jti と exp を返す。
 * OIDC Core 1.0 §9 / RFC 7523 §3
 *
 * 1. JWS Compact Serialization を分解する
 * 2. ヘッダーの alg が受け付ける非対称アルゴリズムで、鍵を外から指定していないことを確かめる
 * 3. ヘッダーの kid、無ければ登録済みのすべての鍵から候補を選び、どれかで署名を検証する
 * 4. iss と sub が client_id、aud がこの OP、exp / nbf / iat が有効期間内、jti があることを確かめる
 *
 * クレームは署名を検証してから読む。jti の再利用検知は {@link rejectReplayedClientAssertion} で別に行い、
 * 戻り値の expiresAt（exp に許容誤差を足した時刻）まで jti を覚えておく。
 *
 * @throws {TokenError} invalid_client
 */
export async function verifyClientAssertion(
  assertion: string,
  options: VerifyClientAssertionOptions,
): Promise<VerifiedClientAssertion> {
  const leeway = options.clockSkewToleranceSec ?? DEFAULT_CLIENT_ASSERTION_CLOCK_SKEW_SEC;
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const { header, payload, signingInput, signature } = decodeClientAssertion(assertion);
  const { algorithm, keyId } = validateClientAssertionHeader(
    header,
    options.supportedSigningAlgs ?? DEFAULT_CLIENT_ASSERTION_SIGNING_ALGS,
  );
  const candidates = selectClientAssertionKeys(requireRegisteredKeys(options.jwks), keyId);
  await verifyClientAssertionSignature(signingInput, signature, candidates, algorithm);

  validateClientAssertionIssuer(payload['iss'], options.clientId);
  validateClientAssertionSubject(payload['sub'], options.clientId);
  validateClientAssertionAudience(payload['aud'], options.audiences);
  const expiration = validateClientAssertionExpiration(payload['exp'], now, leeway);
  validateClientAssertionNotBefore(payload['nbf'], now, leeway);
  validateClientAssertionIssuedAt(payload['iat'], now, leeway);
  const jti = requireClientAssertionJti(payload['jti']);

  // exp を過ぎても leeway の間は受け付けるので、jti はその間も覚えておく。
  return { jti, expiresAt: expiration + leeway };
}

/**
 * クライアントアサーションの JWS Compact Serialization を分解し、ヘッダーとペイロードを
 * JSON オブジェクトとして読む。署名もクレームも検証しない。
 * base64url は RFC 8725 §3.11 に従って厳密に読む。
 *
 * @throws {TokenError} invalid_client
 */
export function decodeClientAssertion(assertion: string): DecodedClientAssertion {
  const parts = assertion.split('.');
  if (parts.length !== 3) {
    throw invalidClient('Client assertion is not a valid JWS compact serialization');
  }
  const [headerB64, payloadB64, signature] = parts as [string, string, string];

  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToArrayBufferStrict(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlToArrayBufferStrict(payloadB64)));
  } catch {
    throw invalidClient('Client assertion header or payload is not valid base64url JSON');
  }
  if (!isJsonObject(header) || !isJsonObject(payload)) {
    throw invalidClient('Client assertion header or payload is not valid base64url JSON');
  }

  return { header, payload, signingInput: `${headerB64}.${payloadB64}`, signature };
}

/**
 * 署名を検証せずに、クライアントアサーションの sub を読む。
 * RFC 7521 §4.2: client_id を送らないリクエストでは、アサーションの subject がクライアントを示す。
 * ここで読んだ値は登録クライアントを引くためだけに使い、{@link verifyClientAssertion} が
 * 署名を検証したうえで sub が client_id と一致することを確かめる。
 *
 * @throws {TokenError} invalid_client
 */
export function readClientAssertionSubject(assertion: string): string {
  const subject = decodeClientAssertion(assertion).payload['sub'];
  if (typeof subject !== 'string' || subject === '') {
    throw invalidClient('Client assertion sub is missing');
  }
  return subject;
}

/**
 * ヘッダーの alg が受け付けるアルゴリズムで、鍵を JWT 側から指定しておらず、
 * typ が別の用途の JWT を示していないことを確かめ、alg と kid を返す。
 *
 * @throws {TokenError} invalid_client
 */
export function validateClientAssertionHeader(
  header: Record<string, unknown>,
  supportedSigningAlgs: readonly string[],
): { algorithm: string; keyId: string | undefined } {
  const algorithm = header['alg'];
  if (typeof algorithm !== 'string' || algorithm === 'none' || !supportedSigningAlgs.includes(algorithm)) {
    throw invalidClient('Client assertion alg is not supported');
  }
  for (const field of FORBIDDEN_HEADER_FIELDS) {
    if (field in header) {
      throw invalidClient(`Client assertion JOSE header contains unsupported field: ${field}`);
    }
  }
  validateClientAssertionType(header['typ']);
  const keyId = typeof header['kid'] === 'string' ? header['kid'] : undefined;
  return { algorithm, keyId };
}

/**
 * ヘッダーの kid があればその kid の登録鍵を、無ければ登録鍵すべてを候補にする。
 * kid に当たる鍵が無いときは、kid を持たない登録鍵を候補にする。kid は鍵を選ぶヒントで
 * （RFC 7515 §4.1.4）、kid 無しで登録した鍵で署名したクライアントがヘッダーに kid を付けても
 * 検証できるようにするためである。
 * alg や鍵の種類との一致は {@link verifyClientAssertionSignature} が確かめる。
 *
 * @throws {TokenError} invalid_client（候補になる鍵が無い）
 */
export function selectClientAssertionKeys(keys: readonly Jwk[], keyId: string | undefined): Jwk[] {
  if (keyId === undefined) return [...keys];
  const named = keys.filter((key) => key.kid === keyId);
  const candidates = named.length > 0 ? named : keys.filter((key) => key.kid === undefined);
  if (candidates.length === 0) {
    throw invalidClient('No registered key of the client matches the client assertion header');
  }
  return candidates;
}

/**
 * 候補の鍵で署名を検証し、どれか 1 つで成功すれば通す。
 * 次の鍵は試さずに飛ばす（RFC 7515 §4.1.1 / RFC 7517 §4.2 / RFC 7518 §3.3）。
 * - alg を持ち、ヘッダーの alg と違う鍵
 * - use が sig 以外の鍵
 * - ヘッダーの alg と鍵の種類・曲線が合わない鍵
 * - 2048 ビット未満の RSA 鍵
 *
 * @throws {TokenError} invalid_client
 */
export async function verifyClientAssertionSignature(
  signingInput: string,
  signature: string,
  candidates: readonly Jwk[],
  algorithm: string,
): Promise<void> {
  for (const jwk of candidates) {
    const importParams = selectImportParams(jwk, algorithm);
    if (importParams === null) continue;
    let publicKey: CryptoKey;
    try {
      publicKey = await crypto.subtle.importKey('jwk', publicMembers(jwk), importParams, false, [
        'verify',
      ]);
    } catch {
      continue;
    }
    try {
      if (await verify(signingInput, signature, publicKey)) return;
    } catch {
      // A malformed signature fails like a wrong one; try the next candidate.
    }
  }
  throw invalidClient('Client assertion signature verification failed');
}

/** OIDC Core 1.0 §9: iss は client_id でなければならない。 */
export function validateClientAssertionIssuer(issuer: unknown, clientId: string): void {
  if (issuer !== clientId) {
    throw invalidClient('Client assertion iss must be the client_id');
  }
}

/** OIDC Core 1.0 §9 / RFC 7523 §3: sub は client_id でなければならない。 */
export function validateClientAssertionSubject(subject: unknown, clientId: string): void {
  if (subject !== clientId) {
    throw invalidClient('Client assertion sub must be the client_id');
  }
}

/**
 * aud（文字列または文字列の配列）の各値が、受け付ける値のどれかであることを確かめる。
 * RFC 7523 §3 は aud がこの認可サーバーを示す値を含むことを、draft-ietf-oauth-rfc7523bis は
 * issuer identifier が唯一の値であることを求める。ここでは別のサーバーを示す値が 1 つでも
 * あれば拒否する。そのアサーションは別のサーバーにも宛てて作られたものだからである
 * （CVE-2025-27370）。
 *
 * @throws {TokenError} invalid_client
 */
export function validateClientAssertionAudience(audience: unknown, audiences: readonly string[]): void {
  const values = typeof audience === 'string' ? [audience] : audience;
  const valid =
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((value) => typeof value === 'string' && audiences.includes(value));
  if (!valid) {
    throw invalidClient('Client assertion aud does not identify this authorization server');
  }
}

/**
 * OIDC Core 1.0 §9: exp は必須。許容誤差を含めて現在時刻を過ぎていれば拒否する。
 *
 * @returns exp（エポック秒）
 * @throws {TokenError} invalid_client
 */
export function validateClientAssertionExpiration(expiration: unknown, now: number, leeway: number): number {
  if (typeof expiration !== 'number' || !Number.isFinite(expiration)) {
    throw invalidClient('Client assertion exp is missing');
  }
  if (expiration + leeway < now) {
    throw invalidClient('Client assertion has expired');
  }
  return expiration;
}

/** RFC 7523 §3: nbf があれば、許容誤差を含めてその時刻より前のアサーションを拒否する。 */
export function validateClientAssertionNotBefore(notBefore: unknown, now: number, leeway: number): void {
  if (notBefore === undefined) return;
  if (typeof notBefore !== 'number' || notBefore - leeway > now) {
    throw invalidClient('Client assertion is not yet valid');
  }
}

/** OIDC Core 1.0 §9: iat は任意。あれば、許容誤差を超えて未来の値を拒否する。 */
export function validateClientAssertionIssuedAt(issuedAt: unknown, now: number, leeway: number): void {
  if (issuedAt === undefined) return;
  if (typeof issuedAt !== 'number' || issuedAt - leeway > now) {
    throw invalidClient('Client assertion iat is in the future');
  }
}

/** OIDC Core 1.0 §9: jti は必須。再利用の検知に使う。 */
export function requireClientAssertionJti(jti: unknown): string {
  if (typeof jti !== 'string' || jti === '') {
    throw invalidClient('Client assertion jti is missing');
  }
  return jti;
}

/**
 * 検証を通ったアサーションの jti をストアに記録し、同じクライアントがすでに使った jti なら拒否する。
 * OIDC Core 1.0 §9: クライアントアサーションは一度しか使ってはならない。
 *
 * @throws {TokenError} invalid_client
 */
export async function rejectReplayedClientAssertion(
  store: ClientAssertionJtiStore,
  entry: { clientId: string; jti: string; expiresAt: number },
): Promise<void> {
  if (!(await store.markUsed(entry))) {
    throw invalidClient('Client assertion has already been used');
  }
}

function requireRegisteredKeys(jwks: JwkSet | undefined): readonly Jwk[] {
  if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    throw invalidClient('The client has no registered keys for private_key_jwt');
  }
  return jwks.keys;
}

/**
 * RFC 7519 §5.1 / draft-ietf-oauth-rfc7523bis: typ は省略、`JWT`、`client-authentication+jwt`
 * のいずれか。RFC 7515 §4.1.9 に従い、大文字小文字を区別せず、`application/` を省いた形でも比べる。
 */
function validateClientAssertionType(type: unknown): void {
  if (type === undefined) return;
  const mediaType = typeof type === 'string' ? type.toLowerCase().replace(/^application\//, '') : '';
  if (!ACCEPTED_TYPES.includes(mediaType)) {
    throw invalidClient('Client assertion typ is not supported');
  }
}

/**
 * ヘッダーの alg と鍵から WebCrypto の importKey パラメータを作る。この鍵で検証してはならない
 * （alg・use・鍵の種類・曲線・鍵長が合わない）ときは null を返す。
 * JWK の alg は任意（RFC 7517 §4.4）なので、鍵の種類はヘッダーの alg から決める。
 */
function selectImportParams(
  jwk: Jwk,
  algorithm: string,
): webcrypto.RsaHashedImportParams | webcrypto.EcKeyImportParams | null {
  const declared = jwk as Partial<Jwk>;
  if (declared.alg !== undefined && declared.alg !== algorithm) return null;
  if (declared.use !== undefined && declared.use !== 'sig') return null;

  const rsaHash = RSA_HASHES[algorithm];
  if (rsaHash !== undefined) {
    if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string') return null;
    if (rsaModulusBitLength(jwk.n) < MIN_RSA_MODULUS_BITS) return null;
    return { name: 'RSASSA-PKCS1-v1_5', hash: rsaHash };
  }

  const curve = EC_CURVES[algorithm];
  if (curve !== undefined) {
    if (jwk.kty !== 'EC' || jwk.crv !== curve) return null;
    return { name: 'ECDSA', namedCurve: curve };
  }

  return null;
}

const RSA_HASHES: Record<string, 'SHA-256' | 'SHA-384' | 'SHA-512' | undefined> = {
  RS256: 'SHA-256',
  RS384: 'SHA-384',
  RS512: 'SHA-512',
};

const EC_CURVES: Record<string, 'P-256' | 'P-384' | 'P-521' | undefined> = {
  ES256: 'P-256',
  ES384: 'P-384',
  ES512: 'P-521',
};

/**
 * importKey に渡す公開鍵のメンバーだけを取り出す。alg / use / key_ops は importKey のパラメータと
 * 食い違うと読み込みに失敗するため、照合は {@link selectImportParams} で済ませて渡さない。
 */
function publicMembers(jwk: Jwk): webcrypto.JsonWebKey {
  return jwk.kty === 'RSA'
    ? { kty: 'RSA', n: jwk.n, e: jwk.e }
    : { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidClient(description: string): TokenError {
  return new TokenError(TokenErrorCode.InvalidClient, description);
}
