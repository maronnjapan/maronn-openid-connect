/**
 * Identity Assertion Authorization Grant (ID-JAG) の受領 — リソース AS 側
 * draft-ietf-oauth-identity-assertion-authz-grant-04 §4.4 / RFC 7523 §2.1・§3 / RFC 7521 §5.2
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * トークンエンドポイントの `urn:ietf:params:oauth:grant-type:jwt-bearer` grant を
 * 処理する。信頼設定済みの外部 IdP が署名した ID-JAG（`typ: oauth-id-jag+jwt`）
 * だけを assertion として受け、検証のうえアクセストークンの発行素材を導出する。
 * 素の RFC 7523 assertion（他の typ）は受けない（仕様の非目標）。
 *
 * トークンの発行・保存は行わない。呼び出し側（生成コード）が core の
 * `buildAccessTokenAudience` / `buildAccessTokenPayload` / `AccessTokenIssuer` /
 * `accessTokenStore` と組み合わせる（token-exchange 機能と同じ分担）。
 *
 * JWS の検証は Web Crypto API による自前実装で、鍵は必ず注入された信頼 IdP の
 * JWKS から選ぶ。assertion の内容（jku ヘッダなど）から鍵の取得先を導出する
 * 経路は存在しない（RFC 8725 §3.1 / SSRF 対策）。ネットワーク取得（jwks_uri）は
 * 本モジュールの責務ではなく、生成コード側で解決してから渡す。
 */
import type { webcrypto } from 'node:crypto';
import {
  extractAlgorithmParamsFromJwk,
  type Jwk,
  type JwkSet,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import {
  ASSERTION_UNTRUSTED_DESCRIPTION,
  IdJagError,
} from './errors.js';
import { ID_JAG_JWT_TYP } from './issue-id-jag.js';

/** RFC 7523 §2.1: JWT authorization grant の grant type 識別子。 */
export const JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/**
 * Clock skew 許容の既定値（秒）。
 * RFC 8725 §3.8: leeway は数分以内に留める。core の ID トークン検証と同じ 60 秒。
 */
export const DEFAULT_ASSERTION_CLOCK_SKEW_SEC = 60;

/**
 * 信頼する IdP の解決済みエントリ。
 *
 * `jwks` は検証時点で手元にある JWK セット（インライン設定、または生成コードが
 * jwks_uri から取得してキャッシュしたもの）。issuer は RFC 8414 §2 の issuer
 * identifier で、assertion の `iss` と byte-exact に比較される。
 */
export interface IdJagTrustedIdentityProvider {
  issuer: string;
  jwks: JwkSet;
}

/** 検証済みの jwt-bearer リクエストパラメータ。 */
export interface ParsedIdJagRedemptionParams {
  assertion: string;
  /** 空白区切りの要求 scope。省略時は undefined（ID-JAG の scope を継承する） */
  scope?: string;
}

/** 検証を通過した ID-JAG のペイロード（draft §3.1）。 */
export interface IdJagAssertionPayload {
  iss: string;
  sub: string;
  aud: string | string[];
  client_id: string;
  jti: string;
  exp: number;
  iat: number;
  scope?: string;
  /** RFC 8707 のリソース識別子。単一 URI または URI 配列（draft §3.1） */
  resource?: string | string[];
  auth_time?: number;
  acr?: string;
  amr?: string[];
}

/**
 * 発行素材。生成コードはこれを core の `buildAccessTokenAudience` /
 * `buildAccessTokenPayload` / `AccessTokenIssuer.issue` / `accessTokenStore.set` へ流す。
 */
export interface IdJagRedemptionGrant {
  /** ID-JAG の sub をそのままローカル subject として使う（JIT 対応は非目標） */
  subject: string;
  /** redemption を要求した認証済みクライアント（= ID-JAG の client_id） */
  clientId: string;
  /** 実効 scope（ID-JAG の scope から offline_access を除去し、要求で縮小した値） */
  scope: string[];
  /** ID-JAG の resource クレーム。core の `buildAccessTokenAudience` の `requested` へ渡す */
  requestedResources?: string[];
  /**
   * 発行するアクセストークンの有効期間（秒）。設定値をそのまま使い、ID-JAG の
   * 残存期間で cap しない（draft §4.4.3: アクセストークン失効後は同じ ID-JAG を
   * 再提示して再取得する設計で、grant はトークンより短命でよい）。
   */
  expiresIn: number;
  /** ID-JAG を発行した IdP の issuer（監査ログとストアメタデータ用） */
  idpIssuer: string;
  /** ID-JAG の jti（ログ相関用。リプレイ拒否には使わない） */
  jti: string;
  authTime?: number;
  acr?: string;
  amr?: string[];
}

/** ID-JAG redemption 処理のコンテキスト。 */
export interface IdJagRedemptionContext {
  /** フォームボディのパラメータ（application/x-www-form-urlencoded） */
  params: Record<string, string>;
  /** 認証済みクライアント（分岐前の共有認証パイプラインが解決したもの） */
  client: TokenClientInfo;
  /** 自 OP（リソース AS）の issuer。assertion の期待 aud であり、自己発行拒否の基準 */
  issuer: string;
  /** 信頼する IdP のリスト（JWKS 解決済み）。既定は空（安全側） */
  identityProviders: IdJagTrustedIdentityProvider[];
  /** 設定上のアクセストークン有効期間（秒） */
  configuredExpiresIn: number;
  /** 現在時刻。テストと決定的な期限計算のために注入できる */
  now?: Date;
  /** exp / iat / nbf 判定の leeway（秒）。既定 60 */
  clockSkewToleranceSec?: number;
}

/**
 * RFC 7515 が「鍵を外部から取得するための情報源」として定義する JOSE Header
 * フィールド。鍵は事前登録済みの信頼 IdP の JWKS からだけ選ぶため、受信 JWS に
 * 含まれていたら即拒否する（RFC 8725 §3.1: SSRF と任意公開鍵差し替えの防止）。
 */
const FORBIDDEN_KEY_HEADERS = ['jku', 'x5u', 'jwk', 'x5c'] as const;

/**
 * ステップ 1: クライアントが jwt-bearer grant を使ってよいかを検証する。
 *
 * RFC 7521 §4.1 は authorization grant の assertion でクライアント認証を必須と
 * しないが、draft §4.4.1 は ID-JAG の client_id クレームと「リクエストの認証
 * クライアント」の一致を MUST とし、§9.1 は confidential client 限定の SHOULD を
 * 置く。本機能はこれを public client の拒否まで強めている（発行側と同じ設計判断）。
 *
 * @throws {IdJagError} unauthorized_client
 */
export function authorizeIdJagRedemptionClient(client: TokenClientInfo): void {
  // RFC 7591 §2: grantTypes 未指定は ['authorization_code'] 扱い。よって redemption は
  // jwt-bearer URN を明示登録したクライアントのみ許される。
  const grantTypes = client.grantTypes ?? ['authorization_code'];
  if (!grantTypes.includes(JWT_BEARER_GRANT_TYPE)) {
    throw new IdJagError(
      'unauthorized_client',
      'The client is not authorized to use the jwt-bearer grant type',
    );
  }
  if (client.tokenEndpointAuthMethod === 'none') {
    throw new IdJagError(
      'unauthorized_client',
      'Public clients are not allowed to use the jwt-bearer grant type',
    );
  }
}

/**
 * ステップ 2: 必須・非対応パラメータを検証して型付けする（RFC 7523 §2.1）。
 *
 * @throws {IdJagError} invalid_request
 */
export function parseIdJagRedemptionParams(
  params: Record<string, string>,
): ParsedIdJagRedemptionParams {
  const assertion = optional(params['assertion']);
  if (assertion === undefined) {
    throw new IdJagError('invalid_request', 'assertion is required');
  }

  // RAR（RFC 9396）は非対応（仕様の非目標）。発行側と同じく明示的に拒否する。
  if (optional(params['authorization_details']) !== undefined) {
    throw new IdJagError(
      'invalid_request',
      'authorization_details is not supported for the jwt-bearer grant',
    );
  }

  return {
    assertion,
    scope: optional(params['scope']),
  };
}

/**
 * ステップ 3: assertion（ID-JAG）を検証し、ペイロードを返す。
 *
 * RFC 7521 §5.2 の一般規則に加え、draft §4.4.1 の処理規則を適用する:
 *
 * 1. compact JWS として構造が正しいこと
 * 2. `typ` が `oauth-id-jag+jwt` であること（RFC 8725 §3.11 の explicit typing。
 *    RFC 7515 §4.1.9 に従い `application/` 前置と大文字小文字の差は許容する）
 * 3. `alg` があり `none` でないこと。外部鍵取得ヘッダが無いこと
 * 4. `iss` が信頼 IdP のいずれかと一致し、かつ自 OP の issuer と異なること
 *    （draft §9.3: 同一ドメイン内で ID-JAG をアクセストークンに引き換えない）
 * 5. 署名がその IdP の JWKS で検証できること（kid 一致を優先、無ければ alg 一致
 *    鍵を順次試行。鍵ごとの alg ピン留めは core の ID トークン検証と同じ規則）
 * 6. `aud` が自 OP の issuer と一致すること。文字列、または要素数 1 の配列のみ
 *    許す（draft §4.4.1 MUST。要素数 2 以上は audience injection として拒否）
 * 7. `exp` / `iat` / `nbf`（存在時）が leeway 内で妥当なこと
 * 8. `jti` / `sub` が非空文字列であること
 * 9. `client_id` が認証済みクライアントと一致すること（draft §4.4.1 MUST。
 *    盗まれた ID-JAG を別クライアントが換金する経路を塞ぐ）
 *
 * `iss` 非信頼と署名不正は同一の固定文言で返し、信頼 IdP リストを応答から
 * 探索させない（{@link ASSERTION_UNTRUSTED_DESCRIPTION}）。それ以外の失敗は、
 * クライアントが手元の assertion から自力で確認できる内容だけを述べる。
 *
 * jti によるリプレイ拒否は行わない。draft §4.4.3 は有効期間内の同一 ID-JAG の
 * 再提示（リフレッシュトークンの代替）を意図しており、束縛はクライアント認証と
 * client_id 一致、短い exp が担う。
 *
 * @throws {IdJagError} invalid_grant
 */
export async function verifyIdJagAssertion(options: {
  assertion: string;
  issuer: string;
  clientId: string;
  identityProviders: IdJagTrustedIdentityProvider[];
  now?: Date;
  clockSkewToleranceSec?: number;
}): Promise<IdJagAssertionPayload> {
  const leeway = options.clockSkewToleranceSec ?? DEFAULT_ASSERTION_CLOCK_SKEW_SEC;

  const parts = options.assertion.split('.');
  if (parts.length !== 3) {
    throw invalidAssertion('The provided assertion is not a valid JWS compact serialization');
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = parseBase64UrlJson(headerB64);
    payload = parseBase64UrlJson(payloadB64);
  } catch {
    throw invalidAssertion('The provided assertion is not a valid JWS compact serialization');
  }

  // draft §4.4.1 / RFC 8725 §3.11: typ の検証で ID トークン等の流用（token
  // confusion）を構造的に拒否する。
  if (!isIdJagTyp(header['typ'])) {
    throw invalidAssertion(`The assertion typ must be ${ID_JAG_JWT_TYP}`);
  }

  const headerAlg = typeof header['alg'] === 'string' ? header['alg'] : undefined;
  if (!headerAlg || headerAlg === 'none') {
    throw invalidAssertion('The assertion alg is missing or "none"');
  }
  for (const field of FORBIDDEN_KEY_HEADERS) {
    if (field in header) {
      throw invalidAssertion(`The assertion JOSE header contains unsupported field: ${field}`);
    }
  }

  const iss = payload['iss'];
  if (typeof iss !== 'string' || iss.length === 0) {
    throw invalidAssertion(ASSERTION_UNTRUSTED_DESCRIPTION);
  }
  // draft §9.3: 自分が発行した ID-JAG を自分で引き換えると、SSO 用の assertion が
  // 同一ドメイン内のアクセストークンへ昇格する抜け道になる。信頼リストの構成に
  // かかわらず拒否する。
  if (iss === options.issuer) {
    throw invalidAssertion(
      'An assertion issued by this authorization server cannot be redeemed here',
    );
  }
  const identityProvider = options.identityProviders.find((idp) => idp.issuer === iss);
  if (identityProvider === undefined) {
    throw invalidAssertion(ASSERTION_UNTRUSTED_DESCRIPTION);
  }

  // 鍵選択: kid 一致を優先し、無ければ alg 一致の鍵を順次試行（core の
  // validateIdTokenHint と同じ規則）。鍵の alg とヘッダの alg の不一致は
  // 検証せず読み飛ばす（RFC 7515 §4.1.1 の鍵ごとの alg ピン留め）。
  const headerKid = typeof header['kid'] === 'string' ? header['kid'] : undefined;
  const candidates = headerKid
    ? identityProvider.jwks.keys.filter((key) => key.kid === headerKid)
    : identityProvider.jwks.keys.filter((key) => key.alg === headerAlg);

  const signingInput = `${headerB64}.${payloadB64}`;
  let signatureValid = false;
  for (const jwk of candidates) {
    if (jwk.alg !== headerAlg) {
      continue;
    }
    if (await verifySignature(signingInput, signatureB64, jwk)) {
      signatureValid = true;
      break;
    }
  }
  if (!signatureValid) {
    // 「鍵が見つからない」も「署名が壊れている」も同一文言（信頼構成の探索防止）。
    throw invalidAssertion(ASSERTION_UNTRUSTED_DESCRIPTION);
  }

  // draft §4.4.1: aud は自 AS の issuer identifier。文字列か、要素数 1 の配列のみ。
  const aud = payload['aud'];
  const audMatches =
    aud === options.issuer ||
    (Array.isArray(aud) && aud.length === 1 && aud[0] === options.issuer);
  if (!audMatches) {
    throw invalidAssertion('The assertion audience does not match this authorization server');
  }

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const exp = payload['exp'];
  if (typeof exp !== 'number') {
    throw invalidAssertion('The assertion is missing an exp claim');
  }
  if (exp + leeway < nowSeconds) {
    throw invalidAssertion('The assertion has expired');
  }
  const iat = payload['iat'];
  if (typeof iat !== 'number') {
    throw invalidAssertion('The assertion is missing an iat claim');
  }
  if (iat > nowSeconds + leeway) {
    throw invalidAssertion('The assertion iat is in the future');
  }
  const nbf = payload['nbf'];
  if (nbf !== undefined) {
    if (typeof nbf !== 'number' || nbf > nowSeconds + leeway) {
      throw invalidAssertion('The assertion is not yet valid');
    }
  }

  const jti = payload['jti'];
  if (typeof jti !== 'string' || jti.length === 0) {
    throw invalidAssertion('The assertion is missing a jti claim');
  }
  const sub = payload['sub'];
  if (typeof sub !== 'string' || sub.length === 0) {
    throw invalidAssertion('The assertion is missing a sub claim');
  }

  // draft §4.4.1: client_id クレームは「リクエストを認証したクライアント」と
  // 一致しなければならない（クライアント継続性）。
  const clientId = payload['client_id'];
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw invalidAssertion('The assertion is missing a client_id claim');
  }
  if (clientId !== options.clientId) {
    throw invalidAssertion('The assertion client_id does not match the authenticated client');
  }

  const scope = payload['scope'];
  if (scope !== undefined && typeof scope !== 'string') {
    throw invalidAssertion('The assertion scope claim must be a string');
  }

  const resource = payload['resource'];
  if (
    resource !== undefined &&
    typeof resource !== 'string' &&
    !(Array.isArray(resource) && resource.every((value) => typeof value === 'string'))
  ) {
    throw invalidAssertion('The assertion resource claim must be a string or an array of strings');
  }

  const authTime = typeof payload['auth_time'] === 'number' ? payload['auth_time'] : undefined;
  const acr = typeof payload['acr'] === 'string' ? payload['acr'] : undefined;
  const amr =
    Array.isArray(payload['amr']) && payload['amr'].every((value) => typeof value === 'string')
      ? (payload['amr'] as string[])
      : undefined;

  return {
    iss,
    sub,
    aud: aud as string | string[],
    client_id: clientId,
    jti,
    exp,
    iat,
    ...(scope === undefined ? {} : { scope }),
    ...(resource === undefined ? {} : { resource: resource as string | string[] }),
    ...(authTime === undefined ? {} : { auth_time: authTime }),
    ...(acr === undefined ? {} : { acr }),
    ...(amr === undefined ? {} : { amr }),
  };
}

/**
 * ステップ 4: 実効 scope を導出する。
 *
 * 許可の上限は ID-JAG の scope クレーム（IdP が許可した範囲。draft §4.4.1 は
 * リソース AS がさらに部分集合へ絞ることを認める）。要求 scope があれば
 * その範囲内で縮小し、無ければ継承する。
 *
 * `offline_access` は常に除去する。jwt-bearer grant では refresh token を発行
 * しない（draft §4.4.3 SHOULD NOT。ID-JAG の再提示が代替）ため、実効 scope に
 * 残すと同意していない長期アクセスの表明になってしまう。
 *
 * @throws {IdJagError} invalid_scope
 */
export function resolveIdJagGrantScope(
  requestedScope: string | undefined,
  assertionScope: string | undefined,
): string[] {
  const granted = splitScope(assertionScope).filter((value) => value !== 'offline_access');
  const requested = splitScope(requestedScope);
  if (requested.length === 0) {
    return granted;
  }
  for (const value of requested) {
    if (!granted.includes(value)) {
      throw new IdJagError(
        'invalid_scope',
        'The requested scope exceeds the scope of the assertion',
      );
    }
  }
  return requested;
}

/**
 * 合成関数: jwt-bearer（ID-JAG）redemption の検証〜発行素材の導出。
 *
 * トークンの発行・保存・応答生成は行わないため、呼び出し側が core の
 * 発行パイプラインと組み合わせる。ID トークンと refresh token は発行しない
 * （jwt-bearer は OIDC の認証フローではなく、refresh token は draft §4.4.3 の
 * SHOULD NOT）。
 *
 * @throws {IdJagError}
 * @throws {RangeError} configuredExpiresIn が正の整数でない場合（設定ミス）
 */
export async function processIdJagRedemptionRequest(
  context: IdJagRedemptionContext,
): Promise<IdJagRedemptionGrant> {
  if (!Number.isInteger(context.configuredExpiresIn) || context.configuredExpiresIn <= 0) {
    throw new RangeError(
      `configuredExpiresIn must be a positive integer, received ${context.configuredExpiresIn}`,
    );
  }

  // クライアント認可を最初に行う。許可されていないクライアントには assertion の
  // 有効性すら判定させない（オラクルを与えない）。
  authorizeIdJagRedemptionClient(context.client);

  const parsed = parseIdJagRedemptionParams(context.params);

  const assertion = await verifyIdJagAssertion({
    assertion: parsed.assertion,
    issuer: context.issuer,
    clientId: context.client.clientId,
    identityProviders: context.identityProviders,
    ...(context.now === undefined ? {} : { now: context.now }),
    ...(context.clockSkewToleranceSec === undefined
      ? {}
      : { clockSkewToleranceSec: context.clockSkewToleranceSec }),
  });

  const scope = resolveIdJagGrantScope(parsed.scope, assertion.scope);

  const requestedResources =
    assertion.resource === undefined
      ? undefined
      : typeof assertion.resource === 'string'
        ? [assertion.resource]
        : [...assertion.resource];

  return {
    subject: assertion.sub,
    clientId: context.client.clientId,
    scope,
    ...(requestedResources === undefined ? {} : { requestedResources }),
    expiresIn: context.configuredExpiresIn,
    idpIssuer: assertion.iss,
    jti: assertion.jti,
    ...(assertion.auth_time === undefined ? {} : { authTime: assertion.auth_time }),
    ...(assertion.acr === undefined ? {} : { acr: assertion.acr }),
    ...(assertion.amr === undefined ? {} : { amr: assertion.amr }),
  };
}

/** 空文字・空白のみを「未指定」として扱う。 */
function optional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function splitScope(scope: string | undefined): string[] {
  if (scope === undefined) return [];
  return [...new Set(scope.split(/\s+/).filter((value) => value.length > 0))];
}

function invalidAssertion(description: string): IdJagError {
  return new IdJagError('invalid_grant', description);
}

/**
 * RFC 7515 §4.1.9: typ は大文字小文字を無視して解釈され、`application/` 前置は
 * 省略形と等価に扱う。`oauth-id-jag+jwt` と `application/oauth-id-jag+jwt` を受ける。
 */
function isIdJagTyp(typ: unknown): boolean {
  if (typeof typ !== 'string') return false;
  const normalized = typ.toLowerCase();
  return normalized === ID_JAG_JWT_TYP || normalized === `application/${ID_JAG_JWT_TYP}`;
}

/** base64url（パディング無し）の JSON セグメントを厳格にパースする。 */
function parseBase64UrlJson(segment: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error('invalid base64url');
  }
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function base64UrlToArrayBuffer(segment: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) {
    throw new Error('invalid base64url');
  }
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * 1 つの JWK で compact JWS の署名を検証する。
 *
 * 検証パラメータは import 済み鍵の algorithm から導出する（ECDSA のハッシュは
 * 曲線に対応する。core の verify ヘルパーと同じ規則）。鍵の import 失敗・
 * アルゴリズム不一致・署名不一致はすべて false（呼び出し側が次の候補鍵を試すか、
 * 最終的に固定文言で拒否する）。
 */
async function verifySignature(
  signingInput: string,
  signatureB64: string,
  jwk: Jwk,
): Promise<boolean> {
  let signature: ArrayBuffer;
  try {
    signature = base64UrlToArrayBuffer(signatureB64);
  } catch {
    return false;
  }

  try {
    const algParams = extractAlgorithmParamsFromJwk(jwk as webcrypto.JsonWebKey);
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      jwk as webcrypto.JsonWebKey,
      algParams,
      false,
      ['verify'],
    );

    const algorithm = publicKey.algorithm;
    let verifyParams: webcrypto.AlgorithmIdentifier | webcrypto.EcdsaParams;
    if (algorithm.name === 'RSASSA-PKCS1-v1_5') {
      verifyParams = { name: 'RSASSA-PKCS1-v1_5' };
    } else if (algorithm.name === 'ECDSA' && 'namedCurve' in algorithm) {
      const namedCurve = (algorithm as webcrypto.EcKeyAlgorithm).namedCurve;
      const hash =
        namedCurve === 'P-256' ? 'SHA-256' : namedCurve === 'P-384' ? 'SHA-384' : 'SHA-512';
      verifyParams = { name: 'ECDSA', hash };
    } else {
      return false;
    }

    return await crypto.subtle.verify(
      verifyParams,
      publicKey,
      signature,
      new TextEncoder().encode(signingInput),
    );
  } catch {
    return false;
  }
}
