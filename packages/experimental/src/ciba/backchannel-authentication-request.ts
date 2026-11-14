/**
 * OpenID Connect Client-Initiated Backchannel Authentication (CIBA) Core 1.0 —
 * Poll モード、§7（バックチャネル認証エンドポイント）
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * バックチャネル認証エンドポイント（`POST /backchannel_authentication`）の処理。
 * Content-Type / 重複パラメータの検証とクライアント認証は、生成コード側の
 * 共有パイプライン（extractClientCredentials → resolveAuthenticatedTokenClient →
 * validateClientAuthMethod → verifyClientSecret）で済ませてから、認証済み
 * クライアントをここへ渡す。
 */
import { generateRandomString, isPublicTokenClient, type TokenClientInfo } from '@maronn-openid-connect/core';
import { BackchannelAuthenticationError } from './errors.js';
import {
  CIBA_GRANT_TYPE,
  type CibaAuthenticationRequestRecord,
  type CibaAuthenticationRequestStore,
} from './store.js';

/** CIBA §7.3: auth_req_id は認可コード同等のエントロピー（256bit）で生成する。 */
const AUTH_REQ_ID_BYTE_LENGTH = 32;

/**
 * CIBA §7.1: binding_message は「表示能力の限られたデバイスに収まる、
 * 比較しやすい短い値」であることが求められる。本実装は 100 文字を上限とし、
 * 制御文字を拒否する（承認画面へ表示する値のため、表示時エスケープと併せた二層防御）。
 */
export const BINDING_MESSAGE_MAX_LENGTH = 100;

/** requested_expiry のクランプ下限（秒）。 */
const REQUESTED_EXPIRY_MIN = 30;

/**
 * ユーザー不存在と resolver 例外を区別させないための単一文言（オラクル防止）。
 */
const UNKNOWN_USER_MESSAGE = 'The login_hint could not be matched to a user';

/**
 * クライアント登録の CIBA 拡張メタデータ。
 *
 * `backchannelTokenDeliveryMode`（CIBA §4 の Registration パラメータ相当）を
 * core の `TokenClientInfo` へ交差型で足す。core の型変更は行わない。
 * 未設定は `poll` とみなす（本 OP は poll しか広告しないため、CIBA grant の
 * 登録を poll 登録と読み替える設計判断）。
 */
export type CibaClientInfo = TokenClientInfo & {
  backchannelTokenDeliveryMode?: 'poll' | 'ping' | 'push';
};

/**
 * login_hint からユーザーを解決する契約（利用者の swap point）。
 *
 * `login_hint` の意味論（メールアドレス / 電話番号 / ユーザー名）は利用者の
 * ユーザーストア設計に依存するため、解決ロジックを丸ごと差し替えられるようにする。
 * 解決できないときは null を返す。例外は不存在と同じ扱いになる（オラクル防止）。
 */
export type CibaUserResolver = (
  loginHint: string,
) => Promise<{ subject: string } | null> | { subject: string } | null;

/** バックチャネル認証エンドポイントの設定値。 */
export interface CibaConfig {
  /** auth_req_id の有効期間（秒）。既定 120、範囲 30–600。 */
  authReqIdExpiresIn: number;
  /** 要求ポーリング間隔の初期値（秒）。既定 5、範囲 1–60。 */
  pollingInterval: number;
  /** 1 subject あたりの保留中リクエスト数の上限。既定 10、範囲 1–100。 */
  maxPendingPerSubject: number;
}

/** CIBA §7.3 の成功レスポンスボディ（JSON のフィールド名そのまま）。 */
export interface BackchannelAuthenticationResponse {
  auth_req_id: string;
  expires_in: number;
  interval: number;
}

/**
 * 認証リクエストを検証して保存し、`auth_req_id` を返す。
 *
 * 呼び出し側は、クライアント認証を済ませたクライアントを `client` に渡す。
 * 生成されたコードでは、共通のパイプラインでクライアント認証を行う。
 *
 * 検証は仕様書の検証順序に合わせて、クライアント、`request` パラメータ、ヒントの規則、`scope`、`binding_message`、`requested_expiry`、`login_hint` からのユーザーの特定、ユーザーごとの保留中のリクエスト数の順に行い、最初に満たさなかった検証のエラーを投げる。
 *
 * すべての検証を通ると、状態が `pending` のレコードを作ってストアに保存し、成功レスポンスのボディ（`auth_req_id`、`expires_in`、`interval`）を返す。
 * `auth_req_id` は、32 バイト（256 ビット）の乱数を base64url で表した値である。
 *
 * @spec CIBA Core 1.0 §7.1
 * @spec CIBA Core 1.0 §7.2
 * @spec CIBA Core 1.0 §7.3
 * @throws {BackchannelAuthenticationError} `unauthorized_client`: パブリッククライアント、CIBA のグラントタイプを登録していないクライアント、`poll` 以外の配信モードを登録したクライアントのとき。
 * @throws {BackchannelAuthenticationError} `invalid_request`: `request` パラメータがある、値のあるヒントが 1 つでない、ヒントが `login_hint` でない、`scope` がない、`requested_expiry` が正の整数でない、保留中のリクエストが上限に達している、のどれかに当たるとき。
 * @throws {BackchannelAuthenticationError} `invalid_scope`: `scope` に `openid` がないとき。
 * @throws {BackchannelAuthenticationError} `invalid_binding_message`: `binding_message` が空文字列か、長さが 100 を超えるか、制御文字を含むとき。
 * @throws {BackchannelAuthenticationError} `unknown_user_id`: `login_hint` からユーザーを特定できないとき。
 */
export async function processBackchannelAuthenticationRequest(input: {
  params: Record<string, string>;
  /** 認証済みクライアント（共有認証パイプラインを通過済みであること）。 */
  client: CibaClientInfo;
  store: CibaAuthenticationRequestStore;
  config: CibaConfig;
  /** OIDC Core 1.0 §11: refresh-token feature が無効なら offline_access は落とす。 */
  refreshTokenFeatureEnabled: boolean;
  resolveUser: CibaUserResolver;
  /** テスト用の時刻注入点。既定は現在時刻。 */
  now?: Date;
}): Promise<BackchannelAuthenticationResponse> {
  const { params, client, store, config } = input;

  validateCibaClient(client);
  rejectSignedRequest(params);
  const loginHint = extractLoginHint(params);
  const scope = applyOfflineAccessPolicy(validateCibaScope(params['scope']), {
    client,
    refreshTokenFeatureEnabled: input.refreshTokenFeatureEnabled,
  });
  const bindingMessage = validateBindingMessage(params['binding_message']);
  const expiresIn = resolveExpiresIn(params['requested_expiry'], config);

  const subject = await resolveSubject(loginHint, input.resolveUser);

  // 同じユーザー宛ての保留中のリクエストを取得し、数が上限に達していれば例外を投げる。
  // 大量の依頼で承認画面が埋まるのを防ぐための、設計上の判断である。
  // CIBA Core 1.0 にはこの場合のエラーコードがないので、終端を示唆しない `invalid_request` に固定の文言を付けて投げる。
  const pending = await store.listPendingBySubject(subject);
  if (pending.length >= config.maxPendingPerSubject) {
    throw new BackchannelAuthenticationError(
      'invalid_request',
      'Too many pending authentication requests for this user',
    );
  }

  const createdAt = input.now ?? new Date();
  const record: CibaAuthenticationRequestRecord = {
    authReqId: generateRandomString(AUTH_REQ_ID_BYTE_LENGTH),
    clientId: client.clientId,
    subject,
    scope,
    status: 'pending',
    createdAt,
    expiresAt: new Date(createdAt.getTime() + expiresIn * 1000),
    interval: config.pollingInterval,
    lastPolledAt: null,
    csrfToken: null,
  };
  if (bindingMessage !== undefined) {
    record.bindingMessage = bindingMessage;
  }
  // `acr_values` は参考値として保存するだけで、要求された `acr` を満たせなくても拒否しない。
  // 発行する ID トークンの `acr` と `amr` は、既存の `acrResolver` が決める。
  const acrValues = params['acr_values'];
  if (acrValues !== undefined && acrValues !== '') {
    record.acrValues = acrValues;
  }
  await store.save(record);

  return {
    auth_req_id: record.authReqId,
    expires_in: expiresIn,
    interval: config.pollingInterval,
  };
}

/**
 * クライアントが CIBA を使えることを確かめる。
 *
 * 認証方式が `none` のパブリッククライアントは拒否する。
 * CIBA §7.1 はクライアント認証を必須（MUST）とし、`none` のクライアントは認証できないためである。
 *
 * 登録したグラントタイプ（`grantTypes`）に {@link CIBA_GRANT_TYPE} がないクライアントも拒否する（RFC 6749 §5.2）。
 * `TokenClientInfo.grantTypes` の既定は `['authorization_code']` なので、CIBA を使うクライアントはこの URN を明示して登録する必要がある。
 *
 * `poll` 以外のトークンの配信モードを登録したクライアントも拒否する。
 * この OP はディスカバリーで `backchannel_token_delivery_modes_supported: ['poll']` だけを公開しているためである。
 * 配信モード（`backchannelTokenDeliveryMode`）を設定していないクライアントは `poll` とみなす。
 *
 * @spec CIBA Core 1.0 §7.1
 * @spec RFC 6749 §5.2
 * @throws {BackchannelAuthenticationError} `unauthorized_client`: パブリッククライアント、CIBA のグラントタイプを登録していないクライアント、`poll` 以外の配信モードを登録したクライアントのとき。
 */
function validateCibaClient(client: CibaClientInfo): void {
  if (isPublicTokenClient(client)) {
    throw new BackchannelAuthenticationError(
      'unauthorized_client',
      'Public clients are not allowed to use the CIBA grant type',
    );
  }
  if (!(client.grantTypes ?? []).includes(CIBA_GRANT_TYPE)) {
    throw new BackchannelAuthenticationError(
      'unauthorized_client',
      'The client is not authorized to use the CIBA grant',
    );
  }
  const deliveryMode = client.backchannelTokenDeliveryMode ?? 'poll';
  if (deliveryMode !== 'poll') {
    throw new BackchannelAuthenticationError(
      'unauthorized_client',
      'This provider only supports the poll token delivery mode',
    );
  }
}

/**
 * `request` パラメータを `invalid_request` で拒否する。
 *
 * この OP は、署名付きの認証リクエスト（CIBA §7.1.1）を受け付けない。
 * `request` パラメータがあれば、値が空文字列でも拒否する。
 *
 * @spec CIBA Core 1.0 §7.1.1
 * @throws {BackchannelAuthenticationError} `invalid_request`: `request` パラメータがあるとき。
 */
function rejectSignedRequest(params: Record<string, string>): void {
  if (params['request'] !== undefined) {
    throw new BackchannelAuthenticationError(
      'invalid_request',
      'Signed authentication requests are not supported',
    );
  }
}

/**
 * ヒントの規則を確かめ、`login_hint` の値を返す。
 *
 * 3 つのヒント（`login_hint`、`id_token_hint`、`login_hint_token`）のうち、値が空でないものはちょうど 1 つでなければならない（CIBA §7.1 の REQUIRED）。
 * 0 個か 2 個以上なら `invalid_request` を投げる（CIBA §7.2 の MUST）。
 *
 * この OP が対応するヒントは `login_hint` だけである。
 * `id_token_hint` か `login_hint_token` だけを提示されたときは、ヒントの種類に対応していないとして、固定の文言の `invalid_request` を投げる。
 * `unknown_user_id`（CIBA §13）は「ヒントからユーザーを特定できない」場合のコードであり、ヒントの種類に対応していないのはリクエストの形式の誤りに当たるので、使わない。
 *
 * @spec CIBA Core 1.0 §7.1
 * @spec CIBA Core 1.0 §7.2
 * @spec CIBA Core 1.0 §13
 * @throws {BackchannelAuthenticationError} `invalid_request`: 値のあるヒントが 1 つでないとき、または `login_hint` 以外のヒントだけを提示されたとき。
 */
function extractLoginHint(params: Record<string, string>): string {
  const presented = (['login_hint', 'id_token_hint', 'login_hint_token'] as const).filter(
    (name) => params[name] !== undefined && params[name] !== '',
  );
  if (presented.length !== 1) {
    throw new BackchannelAuthenticationError(
      'invalid_request',
      'Exactly one of login_hint, id_token_hint or login_hint_token is required',
    );
  }
  if (presented[0] !== 'login_hint') {
    throw new BackchannelAuthenticationError(
      'invalid_request',
      'Only login_hint is supported by this provider',
    );
  }
  // `presented` の判定を通っているので、`login_hint` の値は空文字列ではない。
  return params['login_hint'] as string;
}

/**
 * `scope` を検証し、重複を除いた値の配列を返す。
 *
 * CIBA §7.1 は、`scope` に `openid` を含めることを求める（CIBA は OpenID Connect の拡張である）。
 * 認可エンドポイントとデバイス認可は `openid` のないリクエストも OAuth 2.0 のリクエストとして受け付けられるが、CIBA は仕様が `openid` を求めるので、設定によらず `scope` と `openid` を必須にする。
 * `scope` がないか空白だけなら `invalid_request` を、`openid` を含まなければ `invalid_scope` を投げる。
 *
 * 値は空白で区切り、重複は最初に現れたものだけを残す。
 * この扱いはデバイス認可グラントと同じである。
 *
 * @spec CIBA Core 1.0 §7.1
 * @throws {BackchannelAuthenticationError} `invalid_request`: `scope` がないか空白だけのとき。
 * @throws {BackchannelAuthenticationError} `invalid_scope`: `scope` に `openid` がないとき。
 */
function validateCibaScope(scope: string | undefined): string[] {
  if (scope === undefined || scope.trim() === '') {
    throw new BackchannelAuthenticationError(
      'invalid_request',
      'Missing required parameter: scope',
    );
  }
  const values = [...new Set(scope.trim().split(/\s+/).filter((value) => value.length > 0))];
  if (!values.includes('openid')) {
    throw new BackchannelAuthenticationError('invalid_scope', 'The openid scope is required');
  }
  return values;
}

/**
 * `scope` から許可しない `offline_access` を除いて返す。
 *
 * 許可条件を満たさない `offline_access` は、エラーにせず無視する（OIDC Core 1.0 §11）。
 * CIBA では認証デバイスの承認画面での承認がそのまま明示的な同意になるので、許可条件は「`refresh-token` 機能が有効である」と「クライアントがグラントタイプ `refresh_token` を登録している」の 2 つだけである。
 * この規則はデバイス認可グラントと同じである。
 *
 * 両方を満たせば `scope` をそのまま返し、満たさなければ `offline_access` を除いた新しい配列を返す。
 *
 * @spec OIDC Core 1.0 §11
 */
function applyOfflineAccessPolicy(
  scope: string[],
  options: { client: CibaClientInfo; refreshTokenFeatureEnabled: boolean },
): string[] {
  const clientAllowsRefresh = (options.client.grantTypes ?? []).includes('refresh_token');
  if (options.refreshTokenFeatureEnabled && clientAllowsRefresh) {
    return scope;
  }
  return scope.filter((value) => value !== 'offline_access');
}

/**
 * `binding_message` を検証し、そのまま返す。
 *
 * `binding_message` がなければ `undefined` を返す。
 * 長さが 1 以上 {@link BINDING_MESSAGE_MAX_LENGTH}（100）以下でないか、制御文字（U+0000〜U+001F と U+007F）を含めば、`invalid_binding_message` を投げる（CIBA §13）。
 * 長さは `length`（UTF-16 の符号単位の数）で数える。
 *
 * 承認画面に表示する値なので、表示するときのエスケープに加えて、ここで制御文字を拒否する。
 *
 * @spec CIBA Core 1.0 §7.1
 * @spec CIBA Core 1.0 §13
 * @throws {BackchannelAuthenticationError} `invalid_binding_message`: 空文字列のとき、長さが 100 を超えるとき、または制御文字を含むとき。
 */
function validateBindingMessage(bindingMessage: string | undefined): string | undefined {
  if (bindingMessage === undefined) return undefined;
  const hasControlCharacter = [...bindingMessage].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
  if (
    bindingMessage.length < 1 ||
    bindingMessage.length > BINDING_MESSAGE_MAX_LENGTH ||
    hasControlCharacter
  ) {
    throw new BackchannelAuthenticationError(
      'invalid_binding_message',
      'binding_message must be 1 to 100 characters without control characters',
    );
  }
  return bindingMessage;
}

/**
 * `requested_expiry` を検証し、有効期間（秒）を返す。
 *
 * `requested_expiry` がなければ、設定の `authReqIdExpiresIn` を返す。
 * あれば、30 以上 `authReqIdExpiresIn` 以下の範囲に収めた値を返す。
 * CIBA §7.1 は値に正の整数を求め、OP がこの値を使ってもよい（MAY）としており、範囲に収めて使うのはこの実装の設計上の判断である。
 *
 * 受け付けるのは 10 進の数字だけからなる 1 以上の値で、小数、符号、指数表記は `invalid_request` で拒否する。
 *
 * @spec CIBA Core 1.0 §7.1
 * @throws {BackchannelAuthenticationError} `invalid_request`: `requested_expiry` が 10 進の数字だけからなる正の整数でないとき。
 */
function resolveExpiresIn(requestedExpiry: string | undefined, config: CibaConfig): number {
  if (requestedExpiry === undefined) {
    return config.authReqIdExpiresIn;
  }
  if (!/^[0-9]+$/.test(requestedExpiry) || Number(requestedExpiry) < 1) {
    throw new BackchannelAuthenticationError(
      'invalid_request',
      'requested_expiry must be a positive integer',
    );
  }
  const requested = Number(requestedExpiry);
  return Math.min(Math.max(requested, REQUESTED_EXPIRY_MIN), config.authReqIdExpiresIn);
}

/**
 * `login_hint` が指すユーザーのサブジェクトを返す。
 *
 * `resolveUser` が `null` を返したときも例外を投げたときも、同じ固定の文言の `unknown_user_id` を投げる（CIBA §13）。
 * ユーザーがいないのか、リゾルバが失敗したのかを、応答から区別できないようにするためである。
 *
 * @spec CIBA Core 1.0 §13
 * @throws {BackchannelAuthenticationError} `unknown_user_id`: ユーザーを特定できないとき。
 */
async function resolveSubject(loginHint: string, resolveUser: CibaUserResolver): Promise<string> {
  let resolved: { subject: string } | null;
  try {
    resolved = await resolveUser(loginHint);
  } catch {
    resolved = null;
  }
  if (resolved === null) {
    throw new BackchannelAuthenticationError('unknown_user_id', UNKNOWN_USER_MESSAGE);
  }
  return resolved.subject;
}
