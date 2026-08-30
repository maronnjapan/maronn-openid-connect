/**
 * Identity Assertion Authorization Grant (ID-JAG) の発行 — IdP 側
 * draft-ietf-oauth-identity-assertion-authz-grant-04 §3 / §4.3
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * 既存トークンエンドポイントの Token Exchange grant（RFC 8693）のうち、
 * `requested_token_type=urn:ietf:params:oauth:token-type:id-jag` の要求を処理する。
 * subject_token として自 OP 発行の ID トークンを受け取り、検証のうえで
 * 別トラストドメインのリソース AS 宛ての署名付き authorization grant JWT
 * （ID-JAG）を発行する。
 *
 * core と同じ「合成関数＋ステップ関数」の二層構成とし、CLI 生成コードは
 * ステップ関数を順に呼び出して検証を差し替え・削除できるようにする。
 * 既存の token-exchange 機能とは grant_type URN を共有するが、コードは共有
 * しない（experimental 機能同士の独立性優先。重複を許容する方針）。
 *
 * ID-JAG の署名は JARM の応答 JWT と同じく Web Crypto API による自前の
 * compact JWS 組み立てで行い、core の非公開な低レベル署名ヘルパーには
 * 依存しない（core 無変更の維持）。
 */
import {
  IdTokenHintError,
  generateRandomString,
  validateIdTokenHint,
  type JwkSet,
  type SigningKey,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import {
  IdJagError,
  SUBJECT_TOKEN_INVALID_DESCRIPTION,
} from './errors.js';

/** RFC 8693 §2.1: token exchange の grant type 識別子（発行側のディスパッチ条件）。 */
export const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';

/** ID-JAG draft §4.3: 要求する token type 識別子。 */
export const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag';

/** RFC 8693 §3: OIDC ID トークンの token type 識別子。本機能が受ける唯一の subject 種別。 */
export const TOKEN_TYPE_ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';

/**
 * ID-JAG draft §3.1: JOSE ヘッダーの `typ` 値。
 * RFC 8725 §3.11 の explicit typing により、ID トークンなど他種の JWT との
 * 取り違え（token confusion）を受領側が構造的に拒否できる。
 */
export const ID_JAG_JWT_TYP = 'oauth-id-jag+jwt';

/**
 * ID-JAG draft §7.2 / §8: authorization grant profile の識別子。
 * discovery の `authorization_grant_profiles_supported` に載せる値。
 */
export const ID_JAG_GRANT_PROFILE = 'urn:ietf:params:oauth:grant-profile:id-jag';

/**
 * ID-JAG の署名アルゴリズム。
 *
 * draft は alg を規定しないため、本 OP の必須アルゴリズムである RS256 に固定する
 * （JARM の応答 JWT と同じ設計）。{@link createIdJagJwt} に渡す `signingKey` は
 * RS256 鍵でなければならない。生成コードは登録鍵セットから
 * `selectSigningKeyByAlg(keys, 'RS256')` で選ぶこと。
 */
const ID_JAG_SIGNING_ALG = 'RS256';

/** RS256 に対応する Web Crypto のアルゴリズム名。 */
const WEB_CRYPTO_ALGORITHM = 'RSASSA-PKCS1-v1_5';

/** 検証済みの ID-JAG 発行リクエストパラメータ（draft §4.3）。 */
export interface ParsedIdJagIssuanceParams {
  subjectToken: string;
  /** リソース AS の issuer identifier（RFC 8414 §2）。draft §4.3 で REQUIRED */
  audience: string;
  /** 空白区切りの要求 scope。省略時は undefined（scope クレームを発行しない） */
  scope?: string;
  /** RFC 8707 §2 のリソース識別子。省略時は undefined */
  resource?: string;
}

/** subject_token（ID トークン）の検証で得た発行素材。 */
export interface IdJagSubject {
  /** ID トークンの sub。ID-JAG の sub にそのまま引き継ぐ（draft §3.1） */
  sub: string;
  /** ID トークンの auth_time（存在する場合のみ。draft §3.1 OPTIONAL） */
  authTime?: number;
  /** ID トークンの acr（存在する場合のみ） */
  acr?: string;
  /** ID トークンの amr（存在する場合のみ） */
  amr?: string[];
}

/** ID-JAG のクレームセット（draft §3.1）。 */
export interface IdJagClaims {
  iss: string;
  sub: string;
  aud: string;
  client_id: string;
  jti: string;
  exp: number;
  iat: number;
  scope?: string;
  resource?: string;
  auth_time?: number;
  acr?: string;
  amr?: string[];
}

/** RFC 8693 §2.2.1 / draft §4.3.4 の成功レスポンスボディ。 */
export interface IdJagIssuanceResponse {
  /** ID-JAG 本体。アクセストークンではないが §2.2.1 の歴史的経緯でこの名前になる */
  access_token: string;
  issued_token_type: typeof ID_JAG_TOKEN_TYPE;
  /** 発行物がアクセストークンではないため常に N_A（draft §4.3.4 REQUIRED） */
  token_type: 'N_A';
  expires_in: number;
  scope: string;
}

/** ID-JAG 発行処理のコンテキスト。 */
export interface IdJagIssuanceContext {
  /** フォームボディのパラメータ（application/x-www-form-urlencoded） */
  params: Record<string, string>;
  /** 認証済みクライアント（分岐前の共有認証パイプラインが解決したもの） */
  client: TokenClientInfo;
  /** 自 OP（IdP）の issuer。ID-JAG の iss になり、subject_token の期待 iss にもなる */
  issuer: string;
  /** subject_token（ID トークン）の署名検証に使う自 OP の JWKS */
  jwks: JwkSet;
  /** ID-JAG の署名鍵。RS256 鍵であること */
  signingKey: SigningKey;
  /** ID-JAG を発行してよいリソース AS issuer の許可リスト。既定は空（安全側） */
  allowedAudiences: string[];
  /** 許可する scope の上限リスト。undefined は素通し（リソース AS 側ポリシーに委ねる） */
  allowedScopes?: string[];
  /** ID-JAG の有効期間（秒） */
  lifetimeSeconds: number;
  /** 現在時刻。テストと決定的な期限計算のために注入できる */
  now?: Date;
}

/**
 * 生成コードのディスパッチ用: この要求が ID-JAG 発行要求かを判定する。
 *
 * grant_type が token-exchange URN で、かつ requested_token_type が ID-JAG の
 * ときだけ真になる。既存の token-exchange 分岐より前に評価することで、両機能を
 * 同時に有効化しても要求が正しい側へ流れる。
 */
export function matchesIdJagIssuanceRequest(params: Record<string, string>): boolean {
  return (
    params['grant_type'] === TOKEN_EXCHANGE_GRANT_TYPE &&
    optional(params['requested_token_type']) === ID_JAG_TOKEN_TYPE
  );
}

/**
 * ステップ 1: クライアントが ID-JAG の発行を要求してよいかを検証する。
 *
 * draft §9.1 は本仕様を confidential client に限る SHOULD を置く。本機能は
 * これを public client の拒否まで強めている（token-exchange 機能と同じ設計判断。
 * ID-JAG はユーザー同意なしで発行されるため、クライアント認証が唯一の束縛になる）。
 *
 * @throws {IdJagError} unauthorized_client
 */
export function authorizeIdJagIssuanceClient(client: TokenClientInfo): void {
  // OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2: grantTypes 未指定は
  // ['authorization_code'] 扱い。よって発行は token-exchange URN を明示登録した
  // クライアントのみ許される。
  const grantTypes = client.grantTypes ?? ['authorization_code'];
  if (!grantTypes.includes(TOKEN_EXCHANGE_GRANT_TYPE)) {
    throw new IdJagError(
      'unauthorized_client',
      'The client is not authorized to use the token-exchange grant type',
    );
  }
  if (client.tokenEndpointAuthMethod === 'none') {
    throw new IdJagError(
      'unauthorized_client',
      'Public clients are not allowed to request an ID-JAG',
    );
  }
}

/**
 * ステップ 2: 必須・非対応パラメータを検証して型付けする（draft §4.3）。
 *
 * 空文字・空白のみの任意パラメータは「送られなかった」と同じに扱う
 * （token-exchange 機能と同じ規則）。
 *
 * @throws {IdJagError} invalid_request
 */
export function parseIdJagIssuanceParams(
  params: Record<string, string>,
): ParsedIdJagIssuanceParams {
  const subjectToken = optional(params['subject_token']);
  if (subjectToken === undefined) {
    throw new IdJagError('invalid_request', 'subject_token is required');
  }

  const subjectTokenType = optional(params['subject_token_type']);
  if (subjectTokenType === undefined) {
    throw new IdJagError('invalid_request', 'subject_token_type is required');
  }
  // draft §4.3 は saml2 / refresh_token の subject も定義するが、本機能は
  // OIDC OP として自 OP 発行の ID トークンだけを受ける（仕様の非目標）。
  if (subjectTokenType !== TOKEN_TYPE_ID_TOKEN) {
    throw new IdJagError(
      'invalid_request',
      `Unsupported subject_token_type for ID-JAG issuance. Only ${TOKEN_TYPE_ID_TOKEN} is supported.`,
    );
  }

  // draft §4.3: audience は REQUIRED（RFC 8693 では OPTIONAL だが、この profile が
  // 必須へ強めている）。ID-JAG の aud クレームそのものになる。
  const audience = optional(params['audience']);
  if (audience === undefined) {
    throw new IdJagError('invalid_request', 'audience is required');
  }

  const resource = optional(params['resource']);
  if (resource !== undefined && !isAbsoluteUriWithoutFragment(resource)) {
    // RFC 8707 §2: resource は絶対 URI で fragment を含んではならない（query は許容）。
    throw new IdJagError(
      'invalid_request',
      'resource must be an absolute URI without a fragment component',
    );
  }

  // draft §4.3 は actor_token を運べることだけを定め、処理規則を定義しない
  // （§9.7: 将来の拡張）。規則が無いまま受け取ると委譲の権限が過大表明され得る
  // ため、明示的に拒否する（fail-safe）。
  if (optional(params['actor_token']) !== undefined || optional(params['actor_token_type']) !== undefined) {
    throw new IdJagError(
      'invalid_request',
      'actor_token is not supported for ID-JAG issuance',
    );
  }

  // RAR（RFC 9396）は非対応（仕様の非目標）。無視して発行すると要求より狭い
  // 権限表明と誤解されるため、明示的に拒否する。
  if (optional(params['authorization_details']) !== undefined) {
    throw new IdJagError(
      'invalid_request',
      'authorization_details is not supported for ID-JAG issuance',
    );
  }

  return {
    subjectToken,
    audience,
    scope: optional(params['scope']),
    resource,
  };
}

/**
 * ステップ 3: subject_token（ID トークン）を検証し、発行素材を返す。
 *
 * draft §4.3.3: IdP は assertion を検証し、その audience（ID トークンの aud）が
 * リクエストのクライアント認証の client_id と一致することを検証しなければ
 * ならない（MUST）。他クライアント宛てに発行された ID トークンの持ち込みを防ぐ。
 *
 * 検証本体は core の `validateIdTokenHint` に委譲する。署名（事前登録 JWKS のみ・
 * kid / alg による鍵選択）、iss、aud、exp / iat（leeway 60 秒）、`alg: none` と
 * 外部鍵取得ヘッダ（jku / jwk / x5u / x5c）の拒否がそのまま適用される。
 *
 * 失敗理由は応答から区別できない（{@link SUBJECT_TOKEN_INVALID_DESCRIPTION}）。
 *
 * @throws {IdJagError} invalid_request（固定文言）
 */
export async function resolveIdJagSubject(options: {
  subjectToken: string;
  issuer: string;
  clientId: string;
  jwks: JwkSet;
}): Promise<IdJagSubject> {
  let payload: { sub: string; [key: string]: unknown };
  try {
    payload = await validateIdTokenHint(options.subjectToken, {
      expectedIss: options.issuer,
      expectedAud: options.clientId,
      jwks: options.jwks,
    });
  } catch (error) {
    if (error instanceof IdTokenHintError) {
      throw new IdJagError('invalid_request', SUBJECT_TOKEN_INVALID_DESCRIPTION);
    }
    throw error;
  }

  // auth_time / acr / amr は ID トークンに存在する場合だけ ID-JAG へ引き継ぐ
  // （draft §3.1 OPTIONAL。リソース AS 側の認証コンテキスト評価の材料）。
  const authTime = typeof payload['auth_time'] === 'number' ? payload['auth_time'] : undefined;
  const acr = typeof payload['acr'] === 'string' ? payload['acr'] : undefined;
  const amr =
    Array.isArray(payload['amr']) && payload['amr'].every((v) => typeof v === 'string')
      ? (payload['amr'] as string[])
      : undefined;

  return {
    sub: payload.sub,
    ...(authTime === undefined ? {} : { authTime }),
    ...(acr === undefined ? {} : { acr }),
    ...(amr === undefined ? {} : { amr }),
  };
}

/**
 * ステップ 4: audience を検証する。
 *
 * - draft §9.3: IdP は自分が発行した ID-JAG に対して同一ドメイン内でアクセス
 *   トークンを発行してはならない。自 OP の issuer と同一の audience 要求は、
 *   その禁止された構成そのものなので発行時点で拒否する（受領側の iss 検証と
 *   合わせた二重ガード）。
 * - 許可リスト（既定は空）に無い audience は拒否する。error_description は
 *   リストの内容・部分一致情報を露出しない固定文言。
 *
 * issuer identifier の比較は byte-exact（RFC 8414 §2 の識別子比較）。
 *
 * @throws {IdJagError} invalid_target
 */
export function validateIdJagAudience(options: {
  audience: string;
  issuer: string;
  allowedAudiences: string[];
}): void {
  if (options.audience === options.issuer) {
    // 利用者が自力で直せる構成エラーなので、この場合だけ理由を明示する
    // （自 OP の issuer は公開情報でありオラクルにならない）。
    throw new IdJagError(
      'invalid_target',
      'The requested audience must belong to a different trust domain than this authorization server',
    );
  }
  if (!options.allowedAudiences.includes(options.audience)) {
    throw new IdJagError(
      'invalid_target',
      'The requested audience is not allowed for ID-JAG issuance',
    );
  }
}

/**
 * ステップ 5: 要求 scope を検証し、ID-JAG に載せる実効 scope を返す。
 *
 * draft §4.3.3: IdP はポリシーを評価し、許可 scope は要求の部分集合であってよい。
 * 本機能のポリシーは「`allowedScopes` が設定されていればその部分集合のみ許可、
 * 未設定なら要求をそのまま許可」。未設定素通しにするのは、scope の意味論が
 * リソース AS のドメインに属し、受領側でも同じ縮小ポリシーが働くため
 * （設計判断。仕様書の設定値の節を参照）。
 *
 * @throws {IdJagError} invalid_scope
 */
export function validateIdJagScope(
  requestedScope: string | undefined,
  allowedScopes: string[] | undefined,
): string[] {
  const requested = splitScope(requestedScope);
  if (allowedScopes === undefined) {
    return requested;
  }
  for (const value of requested) {
    if (!allowedScopes.includes(value)) {
      throw new IdJagError(
        'invalid_scope',
        'The requested scope exceeds the scopes allowed for ID-JAG issuance',
      );
    }
  }
  return requested;
}

/**
 * ステップ 6: ID-JAG のクレームセットを組み立てる（draft §3.1）。
 *
 * - `client_id` は交換を要求した認証済みクライアントの client_id。draft §5 は
 *   リソース AS 側で別の client_id を使う対応付けも認めるが、本機能は両 AS で
 *   同一 client_id を使う前提に固定する（仕様の非目標）。
 * - `scope` は空配列のときクレーム自体を含めない（draft §3.1 OPTIONAL）。
 * - `jti` は 256bit のランダム値。受領側はリプレイ拒否には使わないが（draft
 *   §4.4.3 の再提示を許すため）、grant 単位の追跡とログ相関に使える。
 *
 * @throws {RangeError} lifetimeSeconds が正の整数でない場合（設定ミス）
 */
export function buildIdJagClaims(options: {
  issuer: string;
  subject: IdJagSubject;
  audience: string;
  clientId: string;
  scope: string[];
  resource?: string;
  lifetimeSeconds: number;
  now?: Date;
}): IdJagClaims {
  if (!Number.isInteger(options.lifetimeSeconds) || options.lifetimeSeconds <= 0) {
    throw new RangeError(
      `lifetimeSeconds must be a positive integer, received ${options.lifetimeSeconds}`,
    );
  }
  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1000);
  return {
    iss: options.issuer,
    sub: options.subject.sub,
    aud: options.audience,
    client_id: options.clientId,
    jti: generateRandomString(32),
    exp: issuedAt + options.lifetimeSeconds,
    iat: issuedAt,
    ...(options.scope.length === 0 ? {} : { scope: options.scope.join(' ') }),
    ...(options.resource === undefined ? {} : { resource: options.resource }),
    ...(options.subject.authTime === undefined ? {} : { auth_time: options.subject.authTime }),
    ...(options.subject.acr === undefined ? {} : { acr: options.subject.acr }),
    ...(options.subject.amr === undefined ? {} : { amr: options.subject.amr }),
  };
}

/**
 * ステップ 7: ID-JAG を compact JWS として署名する。
 *
 * JOSE ヘッダーは `{ alg: 'RS256', typ: 'oauth-id-jag+jwt', kid }`。
 * `typ` は受領側の必須検証項目（draft §4.4.1 / RFC 8725 §3.11）なので必ず付ける。
 * `kid` を含めるのは、受領側が IdP の JWKS から鍵を一意に選べるようにするため。
 *
 * @param options.signingKey RS256 鍵であること（alg 表明と鍵種の不一致は Web
 *   Crypto が署名時に例外にするため、偽った alg の JWS は生成されない）
 */
export async function createIdJagJwt(options: {
  claims: IdJagClaims;
  signingKey: SigningKey;
}): Promise<string> {
  const encodedHeader = base64UrlFromJson({
    alg: ID_JAG_SIGNING_ALG,
    typ: ID_JAG_JWT_TYP,
    kid: options.signingKey.keyId,
  });
  const encodedPayload = base64UrlFromJson(options.claims as unknown as Record<string, unknown>);
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = await crypto.subtle.sign(
    WEB_CRYPTO_ALGORITHM,
    options.signingKey.privateKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

/**
 * ステップ 8: RFC 8693 §2.2.1 / draft §4.3.4 の応答ボディを組み立てる。
 *
 * `token_type` は常に `N_A`（発行物はアクセストークンではない）。`scope` は
 * draft 上「要求と同一なら OPTIONAL」だが、判定分岐を避けるため常に含める
 * （token-exchange 機能と同じ設計判断。scope 無しの発行では空文字列）。
 * refresh_token は返さない（draft §4.3.4 SHOULD NOT）。
 */
export function buildIdJagIssuanceResponse(options: {
  idJag: string;
  expiresIn: number;
  scope: string[];
}): IdJagIssuanceResponse {
  return {
    access_token: options.idJag,
    issued_token_type: ID_JAG_TOKEN_TYPE,
    token_type: 'N_A',
    expires_in: options.expiresIn,
    scope: options.scope.join(' '),
  };
}

/**
 * 合成関数: ID-JAG 発行の検証〜応答生成（draft §4.3）。
 *
 * 個々のステップ関数を仕様順に合成しただけの API。ID-JAG はストアに保存しない
 * （自己完結した署名付き grant であり、受領側が署名と exp で検証する）。
 *
 * @throws {IdJagError}
 */
export async function processIdJagIssuanceRequest(
  context: IdJagIssuanceContext,
): Promise<IdJagIssuanceResponse> {
  // クライアント認可を最初に行う。許可されていないクライアントには
  // subject_token の有効性すら判定させない（オラクルを与えない）。
  authorizeIdJagIssuanceClient(context.client);

  const parsed = parseIdJagIssuanceParams(context.params);

  const subject = await resolveIdJagSubject({
    subjectToken: parsed.subjectToken,
    issuer: context.issuer,
    clientId: context.client.clientId,
    jwks: context.jwks,
  });

  validateIdJagAudience({
    audience: parsed.audience,
    issuer: context.issuer,
    allowedAudiences: context.allowedAudiences,
  });

  const scope = validateIdJagScope(parsed.scope, context.allowedScopes);

  const claims = buildIdJagClaims({
    issuer: context.issuer,
    subject,
    audience: parsed.audience,
    clientId: context.client.clientId,
    scope,
    ...(parsed.resource === undefined ? {} : { resource: parsed.resource }),
    lifetimeSeconds: context.lifetimeSeconds,
    ...(context.now === undefined ? {} : { now: context.now }),
  });

  const idJag = await createIdJagJwt({
    claims,
    signingKey: context.signingKey,
  });

  return buildIdJagIssuanceResponse({
    idJag,
    expiresIn: context.lifetimeSeconds,
    scope,
  });
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

/**
 * RFC 8707 §2: resource は絶対 URI（RFC 3986 §4.3）で fragment を含んではならない。
 * query は許容される。
 */
function isAbsoluteUriWithoutFragment(value: string): boolean {
  if (value.includes('#')) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol.length > 0;
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlFromJson(value: Record<string, unknown>): string {
  return base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(value)));
}
