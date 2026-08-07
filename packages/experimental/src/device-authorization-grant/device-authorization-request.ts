/**
 * OAuth 2.0 Device Authorization Grant — RFC 8628 §3.1 / §3.2
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * デバイス認可エンドポイント（`POST /device_authorization`）の処理。core と同じく
 * 「合成関数＋ステップ関数」の二層構成とし、CLI 生成コードはステップ関数を順に
 * 呼び出して処理を組み立てられるようにする。
 *
 * クライアント認証は生成コード側の共有パイプライン（extractClientCredentials →
 * resolveAuthenticatedTokenClient → validateClientAuthMethod → verifyClientSecret）
 * で済ませてから、認証済みクライアントをここへ渡す。
 */
import { generateRandomString } from '@maronn-openid-connect/core';
import { DeviceAuthorizationError } from './errors.js';
import { generateUniqueUserCode } from './user-code.js';
import {
  DEVICE_CODE_GRANT_TYPE,
  type DeviceAuthorizationRecord,
  type DeviceAuthorizationStore,
} from './store.js';

/** RFC 8628 §5.2: device_code は認可コード同等のエントロピー（256bit）で生成する。 */
const DEVICE_CODE_BYTE_LENGTH = 32;

/** RFC 8628 §3.2 の既定値。生成コードの config から上書きできる。 */
export const DEFAULT_DEVICE_CODE_EXPIRES_IN = 600;
/** RFC 8628 §3.2: interval を省略した場合クライアントは 5 秒を使う MUST。 */
export const DEFAULT_POLL_INTERVAL = 5;

/** デバイス認可エンドポイントに渡す最小限のクライアント情報。 */
export interface DeviceAuthorizationClient {
  clientId: string;
  /** 登録済み grant_types。URN 未登録は unauthorized_client。 */
  grantTypes?: string[];
}

/** RFC 8628 §3.2 の成功レスポンス（JSON のフィールド名そのまま）。 */
export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/**
 * ステップ 1: クライアントがデバイス認可グラントを許可されているか検証する。
 *
 * RFC 6749 §5.2: 登録済み grant_types に含まれないグラントは unauthorized_client。
 *
 * @throws {DeviceAuthorizationError} unauthorized_client
 */
export function validateDeviceGrantAllowed(client: DeviceAuthorizationClient): void {
  const grantTypes = client.grantTypes ?? [];
  if (!grantTypes.includes(DEVICE_CODE_GRANT_TYPE)) {
    throw new DeviceAuthorizationError(
      'unauthorized_client',
      'The client is not authorized to use the device_code grant',
    );
  }
}

/**
 * ステップ 2: scope を検証して正規化する。
 *
 * RFC 8628 §3.1 では scope は OPTIONAL だが、本 OP は認可エンドポイントと同じ
 * プロファイル制限（scope 必須・`openid` 必須）をデバイス認可にも課す。RFC 8628 が
 * 許容する scope 省略には対応しない、既知の制限である。
 *
 * 空白区切り・重複除去の扱いは core の `validateAuthorizationScope` と同じ規則。
 *
 * @throws {DeviceAuthorizationError} invalid_request / invalid_scope
 */
export function validateDeviceAuthorizationScope(scope: string | undefined): string[] {
  if (scope === undefined || scope.trim() === '') {
    throw new DeviceAuthorizationError(
      'invalid_request',
      'Missing required parameter: scope',
    );
  }
  const values = [...new Set(scope.trim().split(/\s+/).filter((value) => value.length > 0))];
  if (!values.includes('openid')) {
    throw new DeviceAuthorizationError(
      'invalid_scope',
      'The openid scope is required',
    );
  }
  return values;
}

/**
 * ステップ 3: 許可条件を満たさない `offline_access` を scope から除去する。
 *
 * OIDC Core 1.0 §11: 許可条件を満たさない offline_access は無視する（エラーには
 * しない）。デバイスフローでは検証 UI の承認画面が明示同意そのものなので、許可条件は
 * 「refresh-token feature が有効」かつ「クライアントが refresh_token grant を登録
 * 済み」の 2 点とし、`prompt=consent` 相当の事前条件は課さない。
 */
export function applyOfflineAccessPolicy(
  scope: string[],
  options: { client: DeviceAuthorizationClient; refreshTokenFeatureEnabled: boolean },
): string[] {
  const clientAllowsRefresh = (options.client.grantTypes ?? []).includes('refresh_token');
  if (options.refreshTokenFeatureEnabled && clientAllowsRefresh) {
    return scope;
  }
  return scope.filter((value) => value !== 'offline_access');
}

/**
 * ステップ 4: device_code / user_code を生成してレコードを保存する。
 *
 * @throws {Error} user_code が規定回数連続で衝突した場合（生成コードは 500 にする）
 */
export async function createDeviceAuthorizationRecord(options: {
  clientId: string;
  scope: string[];
  store: DeviceAuthorizationStore;
  expiresIn: number;
  interval: number;
  now?: Date;
}): Promise<DeviceAuthorizationRecord> {
  const { userCode, userCodeDisplay } = await generateUniqueUserCode(options.store);
  const createdAt = options.now ?? new Date();
  const record: DeviceAuthorizationRecord = {
    deviceCode: generateRandomString(DEVICE_CODE_BYTE_LENGTH),
    userCode,
    userCodeDisplay,
    clientId: options.clientId,
    scope: options.scope,
    status: 'pending',
    createdAt,
    expiresAt: new Date(createdAt.getTime() + options.expiresIn * 1000),
    interval: options.interval,
    lastPolledAt: null,
    csrfToken: null,
    bindingHash: null,
    loginAttempts: 0,
  };
  await options.store.save(record);
  return record;
}

/**
 * ステップ 5: RFC 8628 §3.2 のレスポンスボディを組み立てる。
 *
 * `verification_uri_complete` は OPTIONAL だが常に返す。user_code がクエリに載るため
 * ユーザー側ブラウザの履歴や中間プロキシのログに残り得るが、user_code はワンタイム
 * かつ短命で、承認操作をした本人以外には価値を持たない。
 */
export function buildDeviceAuthorizationResponse(
  record: DeviceAuthorizationRecord,
  issuer: string,
): DeviceAuthorizationResponse {
  const verificationUri = `${issuer}/device`;
  return {
    device_code: record.deviceCode,
    user_code: record.userCodeDisplay,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(record.userCodeDisplay)}`,
    expires_in: Math.round((record.expiresAt.getTime() - record.createdAt.getTime()) / 1000),
    interval: record.interval,
  };
}

/**
 * 合成関数: デバイス認可エンドポイントの全処理（RFC 8628 §3.1 / §3.2）。
 *
 * 個々のステップ関数を仕様順に合成しただけの API。生成コードは通常この関数ではなく
 * ステップ関数を順に呼び出し、検証の差し替え・削除ができるようにする。
 *
 * @throws {DeviceAuthorizationError}
 */
export async function processDeviceAuthorizationRequest(input: {
  params: Record<string, string>;
  client: DeviceAuthorizationClient;
  issuer: string;
  expiresIn?: number;
  interval?: number;
  refreshTokenFeatureEnabled: boolean;
  store: DeviceAuthorizationStore;
  now?: Date;
}): Promise<DeviceAuthorizationResponse> {
  validateDeviceGrantAllowed(input.client);

  const requestedScope = validateDeviceAuthorizationScope(input.params['scope']);
  const scope = applyOfflineAccessPolicy(requestedScope, {
    client: input.client,
    refreshTokenFeatureEnabled: input.refreshTokenFeatureEnabled,
  });

  const record = await createDeviceAuthorizationRecord({
    clientId: input.client.clientId,
    scope,
    store: input.store,
    expiresIn: input.expiresIn ?? DEFAULT_DEVICE_CODE_EXPIRES_IN,
    interval: input.interval ?? DEFAULT_POLL_INTERVAL,
    now: input.now,
  });

  return buildDeviceAuthorizationResponse(record, input.issuer);
}
