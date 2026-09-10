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
import { generateRandomString, type TokenClientInfo } from '@maronn-openid-connect/core';
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
 * バックチャネル認証エンドポイントの全処理（CIBA §7.1 / §7.2 / §7.3）。
 *
 * 検証は仕様書の検証順序どおりに進む: クライアント検証（auth method none 拒否 →
 * CIBA grant 登録 → delivery mode）→ `request` 拒否 → ヒント規則 → scope →
 * binding_message → requested_expiry → login_hint 解決 → 保留数制限 →
 * レコード生成・保存。
 *
 * @throws {BackchannelAuthenticationError}
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

  // 承認 UI の flood 対策（設計判断。CIBA Core に該当エラーは無いため
  // 終端を示唆しない invalid_request の固定文言で返す）。
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
  // acr_values は advisory として保存するだけで、要求 acr を満たさない場合の
  // 拒否は行わない（発行 ID トークンの acr / amr は既存の acrResolver が解決する）。
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
 * クライアント側の検証（検証順序 3〜5）。
 *
 * - CIBA §7.1 はクライアント認証を MUST とするため、認証を行えない
 *   auth method `none`（public client）は要件を満たせない
 * - RFC 6749 §5.2: 登録済み grant_types に含まれないグラントは unauthorized_client。
 *   `TokenClientInfo.grantTypes` の既定は `['authorization_code']` のため、
 *   CIBA を使うクライアントは URN の明示登録が必要
 * - 本 OP は discovery で `backchannel_token_delivery_modes_supported: ['poll']`
 *   のみを広告するため、poll 以外を登録したクライアントは拒否する。未設定は
 *   poll とみなす
 *
 * @throws {BackchannelAuthenticationError} unauthorized_client
 */
function validateCibaClient(client: CibaClientInfo): void {
  if (client.tokenEndpointAuthMethod === 'none') {
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
 * CIBA §7.1.1 の署名付き認証リクエスト（`request` パラメータ）は受け付けない。
 *
 * @throws {BackchannelAuthenticationError} invalid_request
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
 * ヒント規則（CIBA §7.1 / §7.2）。
 *
 * 「3 つのヒントのうちちょうど 1 つ」が REQUIRED。0 個・2 個以上は
 * invalid_request（§7.2 MUST）。対応するヒントは login_hint のみで、
 * id_token_hint / login_hint_token の単独提示はヒント種別の非対応として
 * invalid_request の固定文言で拒否する（§13 `unknown_user_id` は「ヒントから
 * ユーザーを特定できない」場合の語彙であり、種別の非対応は malformed 系）。
 *
 * @throws {BackchannelAuthenticationError} invalid_request
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
  // presented の要素判定を通っているため空文字ではない。
  return params['login_hint'] as string;
}

/**
 * scope を検証して正規化する。
 *
 * CIBA §7.1 は scope に `openid` を含めることを求める（CIBA は OIDC 拡張）。
 * 本 OP は認可エンドポイント・デバイス認可と同じプロファイル制限
 * （scope 必須・`openid` 必須）を課す。空白区切り・重複除去の扱いは
 * device-authorization-grant と同じ規則。
 *
 * @throws {BackchannelAuthenticationError} invalid_request / invalid_scope
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
 * 許可条件を満たさない `offline_access` を scope から除去する。
 *
 * OIDC Core 1.0 §11: 許可条件を満たさない offline_access は無視する（エラーには
 * しない）。CIBA では認証デバイス UI の承認画面が明示同意そのものなので、許可
 * 条件は「refresh-token feature が有効」かつ「クライアントが refresh_token
 * grant を登録済み」の 2 点とする（device-authorization-grant と同じ規則）。
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
 * binding_message を検証する（CIBA §7.1 / §13 invalid_binding_message）。
 *
 * @throws {BackchannelAuthenticationError} invalid_binding_message
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
 * requested_expiry を検証してクランプ済みの有効期間（秒）を返す。
 *
 * CIBA §7.1 は正の整数を求め、「The server MAY use this value」とする。本実装は
 * `[30, authReqIdExpiresIn]` へクランプして採用する（設計判断）。10 進数字のみを
 * 受理し、小数・符号・指数表記は拒否する。
 *
 * @throws {BackchannelAuthenticationError} invalid_request
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
 * login_hint を subject へ解決する（CIBA §13 unknown_user_id）。
 *
 * resolver の例外と不存在を同じ固定文言にし、失敗理由を応答から区別させない。
 *
 * @throws {BackchannelAuthenticationError} unknown_user_id
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
