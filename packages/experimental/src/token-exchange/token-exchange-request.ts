/**
 * OAuth 2.0 Token Exchange — RFC 8693
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * トークンエンドポイントの `urn:ietf:params:oauth:grant-type:token-exchange` grant を
 * 処理する。「合成関数＋ステップ関数」の二層構成とし、CLI 生成コードは
 * ステップ関数を順に呼び出して検証を差し替え・削除できるようにする。
 *
 * **impersonation 型**（`actor_token` なし。交換後トークンは subject として振る舞う）と
 * **delegation 型**（`actor_token` あり。RFC 8693 §4.1 の `act` claim で actor を記録する）の
 * 両方に対応する。どちらでも、交換で権限が単調に狭まること（scope は部分集合・
 * audience は許可リスト内・寿命は subject_token の残存期間以下・`sub` は変更不可）が
 * 本モジュールのセキュリティ設計の中核である。
 *
 * トークンの発行・保存は行わない。呼び出し側（生成コード）が core の
 * `buildAccessTokenAudience` / `buildAccessTokenPayload` / `AccessTokenIssuer` /
 * `accessTokenStore` と組み合わせる。
 */
import {
  isPublicTokenClient,
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
 * actor_token の解決に失敗したときの固定 error_description。
 * {@link SUBJECT_TOKEN_INVALID_DESCRIPTION} と同じオラクル排除方針で、
 * どのパラメータが不正だったかだけを伝え、失敗理由は区別しない。
 */
export const ACTOR_TOKEN_INVALID_DESCRIPTION =
  'The provided actor_token is not valid';

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

/**
 * RFC 8693 §4.1 の `act` claim 値。
 *
 * `sub` が現在の actor。委譲が連鎖した場合は `act` のネストでチェーンを表し、
 * 最外が現在の actor、最深が最も古い actor になる。
 */
export interface TokenExchangeActor {
  sub: string;
  act?: TokenExchangeActor;
}

/**
 * 交換で発行したトークンの store metadata。
 *
 * core の {@link AccessTokenInfo} に `act` を加えた構造的拡張。生成コードが
 * delegation の発行時にこの形で store へ保存しておくと、そのトークンを後日
 * subject_token として再交換したときに {@link processTokenExchangeRequest} が
 * `act` を読み出して委譲チェーンを繋げられる（core は無変更のまま）。
 */
export type ExchangedAccessTokenInfo = AccessTokenInfo & {
  act?: TokenExchangeActor;
};

/** 検証済みの Token Exchange リクエストパラメータ（RFC 8693 §2.1）。 */
export interface ParsedTokenExchangeParams {
  subjectToken: string;
  /** 空白区切りの要求 scope。省略時は undefined（subject の scope を継承する） */
  scope?: string;
  audience?: string;
  resource?: string;
  /** delegation の actor_token。省略時は undefined（impersonation） */
  actorToken?: string;
}

/**
 * 発行素材。生成コードはこれを core の `buildAccessTokenAudience` /
 * `buildAccessTokenPayload` / `AccessTokenIssuer.issue` / `accessTokenStore.set` へ流す。
 */
export interface TokenExchangeGrant {
  /** subject_token の `sub` を継承する（delegation でも actor は `act` にのみ現れる） */
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
  /**
   * delegation の act claim 値（RFC 8693 §4.1）。impersonation では undefined。
   * 生成コードは JWT payload と store metadata の両方へ `act` として載せる。
   */
  actor?: TokenExchangeActor;
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
 * トークン交換を許されないクライアントなら例外を投げる。
 *
 * クライアントの `grantTypes` にトークン交換のグラントタイプ（`urn:ietf:params:oauth:grant-type:token-exchange`）がないとき、またはパブリッククライアントのときに、`unauthorized_client` の {@link TokenExchangeError} を投げる。
 *
 * パブリッククライアントを拒否するのは、この機能の設計上の判断である。
 * RFC 8693 §2.1 は、クライアント認証を省くと、盗まれたトークンを持つ誰もが、STS（トークンを交換するサーバー）を通してそのトークンを別のトークンに交換できてしまうと注意している。
 * この機能は、その注意を、パブリッククライアントを拒否するところまで強めている。
 *
 * @throws {TokenExchangeError} `unauthorized_client`: トークン交換のグラントタイプが登録されていないとき、またはパブリッククライアントのとき
 * @spec RFC 8693 §2.1
 */
export function authorizeTokenExchangeClient(client: TokenClientInfo): void {
  // `grantTypes` が登録されていなければ、`['authorization_code']` として扱う（OpenID Connect Dynamic Client Registration 1.0 §2、RFC 7591 §2）。
  // そのため、トークン交換を使えるのは、トークン交換のグラントタイプを明示的に登録したクライアントだけである。
  const grantTypes = client.grantTypes ?? ['authorization_code'];
  if (!grantTypes.includes(TOKEN_EXCHANGE_GRANT_TYPE)) {
    throw new TokenExchangeError(
      'unauthorized_client',
      'The client is not authorized to use the token-exchange grant type',
    );
  }
  if (isPublicTokenClient(client)) {
    throw new TokenExchangeError(
      'unauthorized_client',
      'Public clients are not allowed to use the token-exchange grant type',
    );
  }
}

/**
 * トークン交換のパラメータを検証し、必要な値を返す。
 *
 * 次のどれかに当てはまるときは、`invalid_request` の {@link TokenExchangeError} を投げる（RFC 8693 §2.1）。
 * - `subject_token` か `subject_token_type` がない。
 * - `subject_token_type`、`requested_token_type`、`actor_token_type` に、アクセストークン（`urn:ietf:params:oauth:token-type:access_token`）以外の種類が指定されている。
 * - `resource` が、フラグメントのない絶対 URI でない。
 * - `actor_token` があるのに `actor_token_type` がない、または `actor_token` がないのに `actor_token_type` がある。
 *
 * パラメータの値は前後の空白を取り除いて使い、空文字列や空白だけの値は、送られなかったものとして扱う。
 * フォームの空欄が、知らないうちに対象や `scope` の指定として扱われないようにするためである。
 *
 * @throws {TokenExchangeError} `invalid_request`: 上のどれかに当てはまるとき
 * @spec RFC 8693 §2.1
 */
export function parseTokenExchangeParams(
  params: Record<string, string>,
): ParsedTokenExchangeParams {
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

  // `requested_token_type` は任意（OPTIONAL）で、アクセストークン以外が指定されたら拒否する（RFC 8693 §2.1）。
  // 省略されたときに何を発行するかは認可サーバーが決めてよく、この機能は常にアクセストークンを発行する。
  const requestedTokenType = optional(params['requested_token_type']);
  if (requestedTokenType !== undefined && requestedTokenType !== TOKEN_TYPE_ACCESS_TOKEN) {
    throw new TokenExchangeError(
      'invalid_request',
      `Unsupported requested_token_type. Only ${TOKEN_TYPE_ACCESS_TOKEN} is supported.`,
    );
  }

  const resource = optional(params['resource']);
  if (resource !== undefined && !isAbsoluteUriWithoutFragment(resource)) {
    // `resource` がフラグメントのない絶対 URI でなければ、`invalid_request` を投げる（RFC 8693 §2.1。クエリは含んでもよい）。
    // 構文の誤りは RFC 6749 §5.2 の `invalid_request` にし、`invalid_target` は「その対象には発行しない」という方針による拒否だけに使う（この機能の設計上の判断）。
    throw new TokenExchangeError(
      'invalid_request',
      'resource must be an absolute URI without a fragment component',
    );
  }

  // 委譲（`actor_token` あり）のパラメータを検証する。
  // `actor_token_type` は、`actor_token` があるときは必須（REQUIRED）で、ないときは含めてはならない（MUST NOT、RFC 8693 §2.1）。
  const actorToken = optional(params['actor_token']);
  const actorTokenType = optional(params['actor_token_type']);
  if (actorToken !== undefined && actorTokenType === undefined) {
    throw new TokenExchangeError(
      'invalid_request',
      'actor_token_type is required when actor_token is present',
    );
  }
  if (actorToken === undefined && actorTokenType !== undefined) {
    throw new TokenExchangeError(
      'invalid_request',
      'actor_token_type must not be present without actor_token',
    );
  }
  if (actorTokenType !== undefined && actorTokenType !== TOKEN_TYPE_ACCESS_TOKEN) {
    throw new TokenExchangeError(
      'invalid_request',
      `Unsupported actor_token_type. Only ${TOKEN_TYPE_ACCESS_TOKEN} is supported.`,
    );
  }

  return {
    subjectToken,
    scope: optional(params['scope']),
    audience: optional(params['audience']),
    resource,
    actorToken,
  };
}

/**
 * `subject_token` を検証し、そのトークンの情報を返す。
 *
 * `subject_token` をアクセストークンのストアから取り出し、見つからない（存在しないか失効済み）、期限切れ、`nbf` が未来のときは、`invalid_request` の {@link TokenExchangeError} を投げる。
 * この機能が受け付けるのはこの OP が発行したアクセストークンだけなので、ストアに保存された情報の検証で、指定された種類のトークンに合った検証を求める RFC 8693 §2.1 の要求（MUST）を満たす。
 *
 * 失敗の理由は、レスポンスから区別できない（説明は {@link SUBJECT_TOKEN_INVALID_DESCRIPTION} で固定）。
 * エラーコードが `invalid_grant` でなく `invalid_request` なのは、RFC 8693 §2.2.2 がそう定めているためである。
 *
 * @throws {TokenExchangeError} `invalid_request`: トークンが見つからない、期限切れ、`nbf` が未来のとき
 * @spec RFC 8693 §2.1
 * @spec RFC 8693 §2.2.2
 */
export async function resolveSubjectToken(options: {
  subjectToken: string;
  accessTokenResolver: AccessTokenResolver;
  now?: Date;
}): Promise<AccessTokenInfo> {
  return resolveExchangeToken(
    options.subjectToken,
    options.accessTokenResolver,
    options.now,
    invalidSubjectToken,
  );
}

/**
 * `actor_token` を検証し、そのトークンの情報を返す。
 *
 * 委譲（`actor_token` があるとき）にだけ使う。
 * 検証の内容は {@link resolveSubjectToken} と同じで、この OP が発行したアクセストークンがストアにあり、期限切れでなく、`nbf` が未来でないことを確かめる。
 *
 * `actor_token` で確かめるのは、交換を要求した時点でアクターが実在し、有効なトークンを持っていることである。
 * 交換で発行するトークンの有効期間は、`actor_token` に連動しない（{@link computeExchangedTokenLifetime}）。
 *
 * 失敗の理由は、レスポンスから区別できない（説明は {@link ACTOR_TOKEN_INVALID_DESCRIPTION} で固定）。
 *
 * @throws {TokenExchangeError} `invalid_request`: トークンが見つからない、期限切れ、`nbf` が未来のとき
 * @spec RFC 8693 §2.1
 */
export async function resolveActorToken(options: {
  actorToken: string;
  accessTokenResolver: AccessTokenResolver;
  now?: Date;
}): Promise<AccessTokenInfo> {
  return resolveExchangeToken(
    options.actorToken,
    options.accessTokenResolver,
    options.now,
    invalidActorToken,
  );
}

/**
 * アクターの `sub` から `act` クレームの値を作って返す。
 *
 * 委譲（`actor_token` があるとき）にだけ使う。
 * 一番外側の `sub` には、今回のアクター（`actorSub`）を入れる。
 * `subject_token` がすでに `act` を持つとき（そのトークン自体が委譲で発行されたとき）は、その委譲の連鎖を `act` の中に入れ子にして残す。
 * これで、一番外側が現在のアクター、一番内側が最も古いアクターになるという RFC 8693 §4.1 の規則を満たす。
 *
 * @spec RFC 8693 §4.1
 */
export function composeActClaim(options: {
  /** actor_token の sub */
  actorSub: string;
  /** subject_token の store metadata に保存されていた act チェーン */
  subjectActChain?: TokenExchangeActor;
}): TokenExchangeActor {
  if (options.subjectActChain === undefined) {
    return { sub: options.actorSub };
  }
  return { sub: options.actorSub, act: options.subjectActChain };
}

/**
 * 要求された `scope` を検証し、交換後の `scope` を返す。
 *
 * 要求された値がすべて `subject_token` の `scope` に含まれていれば、要求された値（重複を除いたもの）を返す。
 * 一つでも含まれなければ `invalid_scope` の {@link TokenExchangeError} を投げ、交換による権限の拡大を防ぐ。
 * `scope` が省略されたときや空白だけのときは、`subject_token` の `scope` をそのまま返す。
 *
 * @returns 交換後のトークンの `scope`
 * @throws {TokenExchangeError} `invalid_scope`: `subject_token` の `scope` にない値を要求したとき
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
 * `audience` と `resource` を許可リストで検証して返す。
 *
 * 指定された `audience` と `resource`（片方だけでもよい）が、すべて許可リスト（`allowedTargets`）にあれば、重複を除いた配列で返す。
 * 一つでもなければ、`invalid_target` の {@link TokenExchangeError} を投げる。
 *
 * 返す値は最終的な `aud` ではなく、生成されたコードが core の `buildAccessTokenAudience()` の `requested` に渡す値である。
 * UserInfo エンドポイントを必ず含めること、重複の除去、空のときに `issuer` を使うことは、ほかのトークンの発行と同じく、その関数に任せる。
 *
 * `audience` と `resource` がどちらも省略されたときは、`subject_token` のオーディエンス（`subjectAudience`）をそのまま返す（ないときは `undefined`）。
 * 対象を変えずに、`scope` の縮小や有効期間の短縮だけを行う交換として扱うためで、対象が無制限になるわけではない。
 *
 * @throws {TokenExchangeError} `invalid_target`: 指定された対象が許可リストにないとき
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
      // `error_description` は固定の文言にし、`allowedTargets` の内容や、どこまで一致したかを返さない。
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
 * 交換で発行するトークンの有効期間（秒）を返す。
 *
 * 有効期間は、設定の有効期間（`configuredExpiresIn`）と、`subject_token` の残りの秒数の、小さいほうである。
 * 交換を何度つないでも、発行するトークンの有効期限は `subject_token` の有効期限を超えないので、交換を繰り返してトークンを使える期間を延ばし続けることはできない。
 *
 * 残りの秒数は `subjectExpiresAt - floor(now / 1000)` で計算する。
 * `expiresAt` は整数の秒であり、同じ `now` で {@link resolveSubjectToken} を通っていれば `subjectExpiresAt` は現在の秒より大きいので、残りの秒数は 1 以上になり、`expires_in: 0` のトークンは発行されない。
 * 残りの秒数が 0 以下のときは、`subject_token` が無効であるとして `invalid_request` を投げる。
 *
 * @throws {TokenExchangeError} `invalid_request`: `subject_token` の残りの有効期間がないとき（防御のための確認）
 * @throws {RangeError} `configuredExpiresIn` が正の整数でないとき（設定の誤り）
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
    // 同じ `now` で `resolveSubjectToken()` を先に通っていれば、ここには来ない。
    // この関数が単独で呼ばれたときのための防御である。
    throw invalidSubjectToken();
  }
  return Math.min(configuredExpiresIn, remaining);
}

/**
 * トークン交換の成功レスポンスのボディを返す。
 *
 * `issued_token_type` はアクセストークンの種類（`urn:ietf:params:oauth:token-type:access_token`）、`token_type` は `Bearer` にし、`scope` は値を空白でつないだ文字列にする。
 *
 * @spec RFC 8693 §2.2.1
 */
export function buildTokenExchangeResponse(options: {
  accessToken: string;
  expiresIn: number;
  scope: string[];
}): TokenExchangeResponse {
  return {
    access_token: options.accessToken,
    issued_token_type: TOKEN_TYPE_ACCESS_TOKEN,
    // 発行したのはアクセストークンなので、常に `Bearer` にする（RFC 8693 の `N_A` は使わない）。
    token_type: 'Bearer',
    expires_in: options.expiresIn,
    // `scope` は、要求と同じでも常に含める。
    // RFC 8693 §2.2.1 では要求と同じなら省略してよい（OPTIONAL）が、同じかどうかを判定する場合分けを避ける。
    scope: options.scope.join(' '),
  };
}

/**
 * トークン交換を検証し、発行に必要な値を返す。
 *
 * クライアントの確認、パラメータの検証、`subject_token` の検証、`actor_token` の検証と `act` クレームの組み立て（委譲のとき）、`scope` の検証、対象の検証、有効期間の計算を、この順に行う。
 * それぞれ、このファイルのほかの関数を呼ぶだけである。
 * 返す値の `subject` と `grantId` は `subject_token` から引き継ぎ、`clientId` は交換を要求したクライアントの値にする。
 *
 * トークンの発行、保存、レスポンスの組み立ては行わない。
 * 呼び出し側が、返した値を core の発行の処理と組み合わせる。
 *
 * @throws {TokenExchangeError} どれかの検証に失敗したとき
 * @throws {RangeError} `configuredExpiresIn` が正の整数でないとき
 * @spec RFC 8693 §2.1
 */
export async function processTokenExchangeRequest(
  context: TokenExchangeRequestContext,
): Promise<TokenExchangeGrant> {
  // クライアントがトークン交換を許されているかを、最初に確かめる。
  // 許されていないクライアントには、`subject_token` が有効であるかどうかも判定させず、トークンの状態を推測する手がかりを与えない。
  authorizeTokenExchangeClient(context.client);

  const parsed = parseTokenExchangeParams(context.params);

  const subject = await resolveSubjectToken({
    subjectToken: parsed.subjectToken,
    accessTokenResolver: context.accessTokenResolver,
    now: context.now,
  });

  // 委譲（`actor_token` あり）のときは、`actor_token` を検証して `act` クレームの値を組み立てる（RFC 8693 §4.1）。
  // `subject_token` 自体が委譲で発行されていれば、その `act` の連鎖を入れ子にして引き継ぐ。
  let actor: TokenExchangeActor | undefined;
  if (parsed.actorToken !== undefined) {
    const actorInfo = await resolveActorToken({
      actorToken: parsed.actorToken,
      accessTokenResolver: context.accessTokenResolver,
      now: context.now,
    });
    actor = composeActClaim({
      actorSub: actorInfo.sub,
      subjectActChain: (subject as ExchangedAccessTokenInfo).act,
    });
  }

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
    ...(actor === undefined ? {} : { actor }),
  };
}

/**
 * 前後の空白を除いた値か、`undefined` を返す。
 *
 * `value` が `undefined` のときと、前後の空白を除くと空文字列になるときは、`undefined`（指定なし）を返す。
 */
function optional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * `scope` の文字列を値の配列に分けて返す。
 *
 * 空白（タブや改行を含む）で区切り、空の要素を除き、重複は最初に現れた順で一つずつ残す。
 * `scope` が `undefined` なら、空の配列を返す。
 */
function splitScope(scope: string | undefined): string[] {
  if (scope === undefined) return [];
  return [...new Set(scope.split(/\s+/).filter((value) => value.length > 0))];
}

/**
 * 時刻をエポック秒（小数点以下は切り捨て）にして返す。
 *
 * `now` を省略したときは、現在時刻を使う。
 */
function toEpochSeconds(now: Date | undefined): number {
  return Math.floor((now ?? new Date()).getTime() / 1000);
}

/**
 * `subject_token` が無効だというエラーを作って返す。
 *
 * `invalid_request` の {@link TokenExchangeError} を作り、投げずに返す。
 * 説明（`error_description`）は常に固定の {@link SUBJECT_TOKEN_INVALID_DESCRIPTION} で、無効な理由を含まない。
 *
 * @spec RFC 8693 §2.2.2
 */
function invalidSubjectToken(): TokenExchangeError {
  return new TokenExchangeError('invalid_request', SUBJECT_TOKEN_INVALID_DESCRIPTION);
}

/**
 * `actor_token` が無効だというエラーを作って返す。
 *
 * `invalid_request` の {@link TokenExchangeError} を作り、投げずに返す。
 * 説明（`error_description`）は常に固定の {@link ACTOR_TOKEN_INVALID_DESCRIPTION} で、無効な理由を含まない。
 *
 * @spec RFC 8693 §2.2.2
 */
function invalidActorToken(): TokenExchangeError {
  return new TokenExchangeError('invalid_request', ACTOR_TOKEN_INVALID_DESCRIPTION);
}

/**
 * トークンをストアから取り出して検証し、その情報を返す。
 *
 * `subject_token` と `actor_token` の検証で共通に使う。
 * トークンが見つからない（存在しないか失効済み）、期限切れ、`nbf` が未来のときは、`invalidToken()` が作ったエラーを投げる。
 *
 * RFC 8693 §2.1 は、認可サーバーが、指定された種類のトークンに合った検証を行うことを求めている（MUST）。
 * この機能が受け付けるのはこの OP が発行したアクセストークンだけなので、ストアに保存された情報の検証（存在、有効期限、`nbf`）でこれを満たす。
 *
 * @throws {TokenExchangeError} `invalidToken()` が作ったエラー: トークンが見つからない、期限切れ、`nbf` が未来のとき
 * @spec RFC 8693 §2.1
 */
async function resolveExchangeToken(
  token: string,
  accessTokenResolver: AccessTokenResolver,
  now: Date | undefined,
  invalidToken: () => TokenExchangeError,
): Promise<AccessTokenInfo> {
  const info = await accessTokenResolver.findAccessToken(token);
  if (info === null) {
    // 存在しないトークンにも、失効したトークンにも、リゾルバは `null` を返す。
    throw invalidToken();
  }

  const nowSeconds = toEpochSeconds(now);
  if (info.expiresAt <= nowSeconds) {
    throw invalidToken();
  }
  if (info.nbf !== undefined && info.nbf > nowSeconds) {
    throw invalidToken();
  }
  return info;
}

/**
 * フラグメントのない絶対 URI なら true を返す。
 *
 * `#` を含む値と、`URL` として解析できない値には false を返す。
 * クエリは含んでもよい。
 * `resource` はフラグメントのない絶対 URI（RFC 3986 §4.3）でなければならないという、RFC 8693 §2.1 の規則を確かめるために使う。
 *
 * @spec RFC 8693 §2.1
 * @spec RFC 3986 §4.3
 */
function isAbsoluteUriWithoutFragment(value: string): boolean {
  if (value.includes('#')) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  // スキームがあることを、念のため明示的に確かめる。
  // `URL` は基準の URL なしでは相対参照を解析できずに例外を投げるので、ここに来た値はスキームを持つ絶対 URI である。
  return parsed.protocol.length > 0;
}
