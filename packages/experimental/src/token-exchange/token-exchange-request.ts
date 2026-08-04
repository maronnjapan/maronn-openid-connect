/**
 * OAuth 2.0 Token Exchange — RFC 8693
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * トークンエンドポイントの `urn:ietf:params:oauth:grant-type:token-exchange` grant を
 * 処理する。core と同じく「合成関数＋ステップ関数」の二層構成とし、CLI 生成コードは
 * ステップ関数を順に呼び出して検証を差し替え・削除できるようにする。
 *
 * 初期スコープは **impersonation 型の交換**（`actor_token` なし）に限定する。
 * 交換で権限が単調に狭まること（scope は部分集合・audience は許可リスト内・
 * 寿命は subject_token の残存期間以下・`sub` は変更不可）が本モジュールの
 * セキュリティ設計の中核である。
 *
 * トークンの発行・保存は行わない。呼び出し側（生成コード）が core の
 * `buildAccessTokenAudience` / `buildAccessTokenPayload` / `AccessTokenIssuer` /
 * `accessTokenStore` と組み合わせる。
 */
import {
  sanitizeErrorDescription,
  type AccessTokenInfo,
  type AccessTokenResolver,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';

/** RFC 8693 §2.1: token exchange の grant type 識別子。 */
export const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';

/** RFC 8693 §3: アクセストークンの token type 識別子。本機能が扱う唯一の種別。 */
export const TOKEN_TYPE_ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';

/**
 * subject_token の解決に失敗したときの固定 error_description。
 *
 * 不存在・期限切れ・nbf 未来・失効済みを区別しない。応答からトークンの存在や
 * 失効状況を推測できる「オラクル」を作らないための意図的な設計（PAR の
 * request_uri 解決失敗と同じ方針）。
 */
export const SUBJECT_TOKEN_INVALID_DESCRIPTION =
  'The provided subject_token is not valid';

/**
 * Token Exchange のエラーコード。
 *
 * RFC 8693 §2.2.2 は RFC 6749 §5.2 の形式を使い、`invalid_target` を追加する。
 * core の `TokenErrorCode` は closed な enum で `invalid_target` を含まないため、
 * core 無変更の制約下では core の `TokenError` に相乗りできない。
 */
export type TokenExchangeErrorCode =
  | 'invalid_request'
  | 'unauthorized_client'
  | 'invalid_scope'
  | 'invalid_target';

/**
 * Token Exchange のエラー。
 *
 * バックチャネル専用（リダイレクトは存在しない）で、常に 400 + JSON で返す。
 * 401 になるのはクライアント認証失敗（`invalid_client`）だけであり、それは
 * 本分岐より前の共有認証パイプライン（core の `TokenError`）が担当する。
 */
export class TokenExchangeError extends Error {
  readonly code: TokenExchangeErrorCode;
  readonly errorDescription: string;

  constructor(code: TokenExchangeErrorCode, errorDescription: string) {
    // RFC 6749 §5.2: error_description は安全な文字集合に限定する。
    const sanitized = sanitizeErrorDescription(errorDescription);
    super(sanitized);
    this.name = 'TokenExchangeError';
    this.code = code;
    this.errorDescription = sanitized;
  }

  /** 本エラーは常に 400（401 は分岐前の共有パイプラインが返す）。 */
  get statusCode(): 400 {
    return 400;
  }
}

/** 検証済みの Token Exchange リクエストパラメータ（RFC 8693 §2.1）。 */
export interface ParsedTokenExchangeParams {
  subjectToken: string;
  /** 空白区切りの要求 scope。省略時は undefined（subject の scope を継承する） */
  scope?: string;
  audience?: string;
  resource?: string;
}

/**
 * 発行素材。生成コードはこれを core の `buildAccessTokenAudience` /
 * `buildAccessTokenPayload` / `AccessTokenIssuer.issue` / `accessTokenStore.set` へ流す。
 */
export interface TokenExchangeGrant {
  /** subject_token の `sub` を継承する（impersonation なので本人固定） */
  subject: string;
  /** 交換を要求したクライアント（subject_token の発行先クライアントではない） */
  clientId: string;
  /** 縮小後の実効 scope */
  scope: string[];
  /** 検証済みの要求対象。core の `buildAccessTokenAudience` の `requested` へ渡す */
  requestedAudience?: string[];
  /** subject_token の残存期間で cap 済みの有効期間（秒） */
  expiresIn: number;
  /** subject_token の `grantId` を継承する（grant 単位失効の連動） */
  grantId?: string;
}

/** RFC 8693 §2.2.1 の成功レスポンスボディ。 */
export interface TokenExchangeResponse {
  access_token: string;
  issued_token_type: typeof TOKEN_TYPE_ACCESS_TOKEN;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

/** Token Exchange 処理のコンテキスト。 */
export interface TokenExchangeRequestContext {
  /** フォームボディのパラメータ（application/x-www-form-urlencoded） */
  params: Record<string, string>;
  /** 認証済みクライアント（分岐前の共有認証パイプラインが解決したもの） */
  client: TokenClientInfo;
  accessTokenResolver: AccessTokenResolver;
  /** `audience` / `resource` で要求できる対象の許可リスト。既定は空（安全側） */
  allowedTargets: string[];
  /** 設定上のアクセストークン有効期間（秒）。subject の残存期間で cap される */
  configuredExpiresIn: number;
  /** 現在時刻。テストと決定的な期限計算のために注入できる */
  now?: Date;
}

/**
 * ステップ 1: クライアントが交換を要求してよいかを検証する。
 *
 * RFC 8693 §2.1 は「クライアント認証を省くと、窃取されたトークンを STS 経由で
 * 別のトークンへ増幅できてしまう」と注記している。本機能はこれを
 * **public client の拒否**まで強めている（設計判断）。
 *
 * @throws {TokenExchangeError} unauthorized_client
 */
export function authorizeTokenExchangeClient(client: TokenClientInfo): void {
  // OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2: grantTypes 未指定は
  // ['authorization_code'] 扱い。よって交換は明示登録したクライアントのみ許される。
  const grantTypes = client.grantTypes ?? ['authorization_code'];
  if (!grantTypes.includes(TOKEN_EXCHANGE_GRANT_TYPE)) {
    throw new TokenExchangeError(
      'unauthorized_client',
      'The client is not authorized to use the token-exchange grant type',
    );
  }
  if (client.tokenEndpointAuthMethod === 'none') {
    throw new TokenExchangeError(
      'unauthorized_client',
      'Public clients are not allowed to use the token-exchange grant type',
    );
  }
}

/**
 * ステップ 2: 必須・非対応パラメータを検証して型付けする（RFC 8693 §2.1）。
 *
 * 空文字・空白のみの任意パラメータは「送られなかった」と同じに扱う
 * （フォームの空フィールドを黙って対象指定・scope 指定に昇格させないため）。
 *
 * @throws {TokenExchangeError} invalid_request
 */
export function parseTokenExchangeParams(
  params: Record<string, string>,
): ParsedTokenExchangeParams {
  // 非目標: delegation（RFC 8693 §1.1 / §4）。未対応であることを明示して拒否する。
  if (params['actor_token'] !== undefined || params['actor_token_type'] !== undefined) {
    throw new TokenExchangeError(
      'invalid_request',
      'Delegation is not supported: actor_token and actor_token_type must not be present.',
    );
  }

  const subjectToken = optional(params['subject_token']);
  if (subjectToken === undefined) {
    throw new TokenExchangeError('invalid_request', 'subject_token is required');
  }

  const subjectTokenType = optional(params['subject_token_type']);
  if (subjectTokenType === undefined) {
    throw new TokenExchangeError('invalid_request', 'subject_token_type is required');
  }
  if (subjectTokenType !== TOKEN_TYPE_ACCESS_TOKEN) {
    throw new TokenExchangeError(
      'invalid_request',
      `Unsupported subject_token_type. Only ${TOKEN_TYPE_ACCESS_TOKEN} is supported.`,
    );
  }

  // RFC 8693 §2.1: requested_token_type は OPTIONAL。省略時の発行種別は AS の裁量で、
  // 本機能は常にアクセストークンを発行する。
  const requestedTokenType = optional(params['requested_token_type']);
  if (requestedTokenType !== undefined && requestedTokenType !== TOKEN_TYPE_ACCESS_TOKEN) {
    throw new TokenExchangeError(
      'invalid_request',
      `Unsupported requested_token_type. Only ${TOKEN_TYPE_ACCESS_TOKEN} is supported.`,
    );
  }

  const resource = optional(params['resource']);
  if (resource !== undefined && !isAbsoluteUriWithoutFragment(resource)) {
    // RFC 8693 §2.1: resource は絶対 URI で fragment を含んではならない（query は許容）。
    // 構文違反は RFC 6749 §5.2 の invalid_request とし、invalid_target は
    // 「対象への発行を拒否する」ポリシー判定に限定する（本仕様の設計判断）。
    throw new TokenExchangeError(
      'invalid_request',
      'resource must be an absolute URI without a fragment component',
    );
  }

  return {
    subjectToken,
    scope: optional(params['scope']),
    audience: optional(params['audience']),
    resource,
  };
}

/**
 * ステップ 3: subject_token を解決し、有効性を検証する。
 *
 * RFC 8693 §2.1: "the authorization server MUST perform the appropriate validation
 * procedures for the indicated token type"。本機能は本 OP 発行のアクセストークンに
 * 限るため、store メタデータの有効性検証（存在・期限・nbf）でこれを満たす。
 *
 * 失敗理由は応答から区別できない（{@link SUBJECT_TOKEN_INVALID_DESCRIPTION}）。
 *
 * @throws {TokenExchangeError} invalid_request（RFC 8693 §2.2.2。`invalid_grant` ではない）
 */
export async function resolveSubjectToken(options: {
  subjectToken: string;
  accessTokenResolver: AccessTokenResolver;
  now?: Date;
}): Promise<AccessTokenInfo> {
  const info = await options.accessTokenResolver.findAccessToken(options.subjectToken);
  if (info === null) {
    // 不存在・失効済みのいずれも resolver が null を返す。
    throw invalidSubjectToken();
  }

  const nowSeconds = toEpochSeconds(options.now);
  if (info.expiresAt <= nowSeconds) {
    throw invalidSubjectToken();
  }
  if (info.nbf !== undefined && info.nbf > nowSeconds) {
    throw invalidSubjectToken();
  }
  return info;
}

/**
 * ステップ 4: 要求 scope が subject_token の scope の部分集合であることを検証する。
 *
 * 権限昇格（scope 拡大）の防止が目的。省略時・空白のみの場合は subject の scope を
 * そのまま継承する（拡大はしない）。
 *
 * @returns 交換後トークンの実効 scope
 * @throws {TokenExchangeError} invalid_scope
 */
export function validateExchangeScope(
  requestedScope: string | undefined,
  subjectScope: string[],
): string[] {
  const requested = splitScope(requestedScope);
  if (requested.length === 0) {
    return [...subjectScope];
  }
  for (const value of requested) {
    if (!subjectScope.includes(value)) {
      throw new TokenExchangeError(
        'invalid_scope',
        'The requested scope exceeds the scope of the subject_token',
      );
    }
  }
  return requested;
}

/**
 * ステップ 5: `audience` / `resource` を許可リストで検証し、要求対象を返す。
 *
 * 戻り値は最終的な `aud` ではなく、生成コードが core の `buildAccessTokenAudience` の
 * `requested` へ渡す入力。UserInfo エンドポイントの恒久メンバ追加・重複除去・
 * 非空フォールバックは既存トークンルートと同じ合成関数に委ねる。
 *
 * 両方が省略された場合は subject_token の audience を継承する（対象変更なしの
 * scope 縮小・期限短縮のみの交換として扱う。無制限になるわけではない）。
 *
 * @throws {TokenExchangeError} invalid_target
 */
export function resolveExchangeTarget(options: {
  audience?: string;
  resource?: string;
  allowedTargets: string[];
  subjectAudience?: string[];
}): string[] | undefined {
  const { audience, resource, allowedTargets, subjectAudience } = options;
  if (audience === undefined && resource === undefined) {
    return subjectAudience === undefined ? undefined : [...subjectAudience];
  }

  const targets: string[] = [];
  for (const requested of [audience, resource]) {
    if (requested === undefined) continue;
    if (!allowedTargets.includes(requested)) {
      // error_description は allowedTargets の内容・部分一致情報を露出しない固定文言。
      throw new TokenExchangeError(
        'invalid_target',
        'The requested target is not allowed for token exchange',
      );
    }
    targets.push(requested);
  }
  return [...new Set(targets)];
}

/**
 * ステップ 6: 発行トークンの有効期間（秒）を算出する。
 *
 * `min(configured, subject の残存秒数)`。交換を何度連鎖しても寿命は単調減少し、
 * 交換によるトークン寿命の洗浄（無期限延命）ができない。
 *
 * 残存秒数は `subjectExpiresAt - floor(now / 1000)` で計算する。`expiresAt` は整数秒で、
 * {@link resolveSubjectToken} を通過した時点で `subjectExpiresAt > now` が保証されるため、
 * この丸め規則では残存秒数は必ず 1 以上になり `expires_in: 0` のトークンは発行されない。
 *
 * @throws {TokenExchangeError} invalid_request（残存期間がない場合の防御的チェック）
 * @throws {RangeError} configuredExpiresIn が正の整数でない場合（設定ミス）
 */
export function computeExchangedTokenLifetime(options: {
  /** Unix epoch 秒 */
  subjectExpiresAt: number;
  configuredExpiresIn: number;
  now?: Date;
}): number {
  const { subjectExpiresAt, configuredExpiresIn } = options;
  if (!Number.isInteger(configuredExpiresIn) || configuredExpiresIn <= 0) {
    throw new RangeError(
      `configuredExpiresIn must be a positive integer, received ${configuredExpiresIn}`,
    );
  }

  const remaining = subjectExpiresAt - toEpochSeconds(options.now);
  if (remaining <= 0) {
    // resolveSubjectToken を先に通していれば到達しない。単独呼び出し時の防御。
    throw invalidSubjectToken();
  }
  return Math.min(configuredExpiresIn, remaining);
}

/** ステップ 7: RFC 8693 §2.2.1 の応答ボディを組み立てる。 */
export function buildTokenExchangeResponse(options: {
  accessToken: string;
  expiresIn: number;
  scope: string[];
}): TokenExchangeResponse {
  return {
    access_token: options.accessToken,
    issued_token_type: TOKEN_TYPE_ACCESS_TOKEN,
    // 発行したのはアクセストークンなので常に Bearer（RFC 8693 の N_A は使わない）。
    token_type: 'Bearer',
    expires_in: options.expiresIn,
    // §2.2.1 は「要求と同一なら OPTIONAL」だが、判定分岐を避けるため常に含める。
    scope: options.scope.join(' '),
  };
}

/**
 * 合成関数: Token Exchange の検証〜発行素材の導出（RFC 8693 §2.1）。
 *
 * 個々のステップ関数を仕様順に合成しただけの API。トークンの発行・保存・応答生成は
 * 行わないため、呼び出し側が core の発行パイプラインと組み合わせる。
 *
 * @throws {TokenExchangeError}
 */
export async function processTokenExchangeRequest(
  context: TokenExchangeRequestContext,
): Promise<TokenExchangeGrant> {
  // クライアント認可を最初に行う。許可されていないクライアントには subject_token の
  // 有効性すら判定させない（オラクルを与えない）。
  authorizeTokenExchangeClient(context.client);

  const parsed = parseTokenExchangeParams(context.params);

  const subject = await resolveSubjectToken({
    subjectToken: parsed.subjectToken,
    accessTokenResolver: context.accessTokenResolver,
    now: context.now,
  });

  const scope = validateExchangeScope(parsed.scope, subject.scope);

  const requestedAudience = resolveExchangeTarget({
    audience: parsed.audience,
    resource: parsed.resource,
    allowedTargets: context.allowedTargets,
    subjectAudience: subject.audience,
  });

  const expiresIn = computeExchangedTokenLifetime({
    subjectExpiresAt: subject.expiresAt,
    configuredExpiresIn: context.configuredExpiresIn,
    now: context.now,
  });

  return {
    subject: subject.sub,
    clientId: context.client.clientId,
    scope,
    requestedAudience,
    expiresIn,
    grantId: subject.grantId,
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

function toEpochSeconds(now: Date | undefined): number {
  return Math.floor((now ?? new Date()).getTime() / 1000);
}

function invalidSubjectToken(): TokenExchangeError {
  return new TokenExchangeError('invalid_request', SUBJECT_TOKEN_INVALID_DESCRIPTION);
}

/**
 * RFC 8693 §2.1: `resource` は絶対 URI（RFC 3986 §4.3）で fragment を含んではならない。
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
  // URL は相対参照を解決しない（base なしでは throw する）ため、ここに来た時点で
  // scheme を持つ絶対 URI である。念のため scheme の存在を明示的に確認する。
  return parsed.protocol.length > 0;
}
