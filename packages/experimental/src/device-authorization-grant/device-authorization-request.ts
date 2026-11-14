/**
 * OAuth 2.0 Device Authorization Grant — RFC 8628 §3.1 / §3.2
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * デバイス認可エンドポイント（`POST /device_authorization`）の処理。
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
 * クライアントがデバイス認可グラントを使えるか確かめる。
 *
 * 登録したグラントタイプ（`grantTypes`）に {@link DEVICE_CODE_GRANT_TYPE} がなければ、`unauthorized_client` を投げる（RFC 6749 §5.2）。
 *
 * @spec RFC 6749 §5.2
 * @throws {DeviceAuthorizationError} `unauthorized_client`: クライアントがデバイスコードのグラントタイプを登録していないとき。
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

/** {@link validateDeviceAuthorizationScope} のオプション。 */
export interface DeviceAuthorizationScopeOptions {
  /**
   * `scope` に `openid` を必須にするか。未指定なら `true`。
   * `false` にすると、`openid` のないリクエストを OAuth 2.0 のデバイス認可リクエストとして受け付ける（RFC 8628 §3.1）。
   * 認可エンドポイントと同じ値を渡すこと。
   */
  requireOpenIdScope?: boolean;
}

/**
 * `scope` を検証し、重複を除いた値の配列を返す。
 *
 * 値は空白で区切り、重複は最初に現れたものだけを残す。
 * この扱いは core の `validateAuthorizationScope` と同じで、`options.requireOpenIdScope` の意味も同じである。
 *
 * `options.requireOpenIdScope` が `true`（既定）なら、認可エンドポイントと同じく OpenID Connect のリクエストだけを受け付ける。
 * `scope` がないか空白だけなら `invalid_request` を、`openid` を含まなければ `invalid_scope` を投げる。
 *
 * `false` なら、`openid` のないリクエストも受け付ける。
 * RFC 8628 §3.1 では `scope` を省略できる（OPTIONAL）が、この OP は既定のスコープを持たないので、`scope` がないか空白だけなら `invalid_scope` を投げる（RFC 6749 §3.3）。
 * `scope` の省略に対応しないのは、既知の制限である。
 *
 * @spec RFC 8628 §3.1
 * @spec RFC 6749 §3.3
 * @throws {DeviceAuthorizationError} `invalid_request`: `openid` を必須にしていて、`scope` がないか空白だけのとき。
 * @throws {DeviceAuthorizationError} `invalid_scope`: `openid` を必須にしていて `scope` に `openid` がないとき、または `openid` を必須にしておらず `scope` がないか空白だけのとき。
 */
export function validateDeviceAuthorizationScope(
  scope: string | undefined,
  options: DeviceAuthorizationScopeOptions = {},
): string[] {
  const requireOpenIdScope = options.requireOpenIdScope ?? true;
  if (scope === undefined || scope.trim() === '') {
    if (!requireOpenIdScope) {
      throw new DeviceAuthorizationError(
        'invalid_scope',
        'Missing scope: this authorization server defines no default scope',
      );
    }
    throw new DeviceAuthorizationError(
      'invalid_request',
      'Missing required parameter: scope',
    );
  }
  const values = [...new Set(scope.trim().split(/\s+/).filter((value) => value.length > 0))];
  if (requireOpenIdScope && !values.includes('openid')) {
    throw new DeviceAuthorizationError(
      'invalid_scope',
      'The openid scope is required',
    );
  }
  return values;
}

/**
 * `scope` から許可しない `offline_access` を除いて返す。
 *
 * 許可条件を満たさない `offline_access` は、エラーにせず無視する（OIDC Core 1.0 §11）。
 * デバイスフローでは検証の画面（`/device`）での承認がそのまま明示的な同意になるので、許可条件は「`refresh-token` 機能が有効である」と「クライアントがグラントタイプ `refresh_token` を登録している」の 2 つだけで、`prompt=consent` に当たる前提は課さない。
 *
 * 両方を満たせば `scope` をそのまま返し、満たさなければ `offline_access` を除いた新しい配列を返す。
 *
 * @spec OIDC Core 1.0 §11
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
 * デバイスコードとユーザーコードを発行し、保存して返す。
 *
 * デバイスコードは 32 バイト（256 ビット）の乱数で、ユーザーコードは {@link generateUniqueUserCode} でストアにまだないものを作る。
 * レコードは状態を `pending` にし、有効期限を `now`（既定は現在時刻）の `expiresIn` 秒後にしてストアに保存し、そのレコードを返す。
 *
 * @throws {Error} ユーザーコードが決められた回数続けて既存のコードと衝突したとき（生成されたコードは 500 で応答する）。
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
 * デバイス認可レスポンスのボディを作って返す。
 *
 * `verification_uri` は `issuer` に `/device` を付けた URL で、`verification_uri_complete` はそれに表示形式の `user_code` をクエリとして付けた URL である。
 * `user_code` には表示形式（`XXXX-XXXX`）の値を、`expires_in` には発行から有効期限までの秒数を入れる。
 *
 * `verification_uri_complete` は省略できる（OPTIONAL）が、常に返す。
 * `user_code` がクエリに入るので、ユーザーのブラウザの履歴や中間のプロキシのログに残ることがあるが、`user_code` は一度しか使えず有効期間も短いので、承認の操作をした本人以外には価値がない。
 *
 * @spec RFC 8628 §3.2
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
 * リクエストを検証して保存し、`device_code` などを返す。
 *
 * デバイス認可エンドポイントの処理を 1 つにまとめた関数で、{@link validateDeviceGrantAllowed}、{@link validateDeviceAuthorizationScope}、{@link applyOfflineAccessPolicy}、{@link createDeviceAuthorizationRecord}、{@link buildDeviceAuthorizationResponse} を仕様の順に呼ぶだけである。
 * 生成されたコードは通常この関数を使わずにこれらの関数を順に呼び、検証を差し替えたり除いたりできるようにしている。
 * `expiresIn` と `interval` を省略すると、{@link DEFAULT_DEVICE_CODE_EXPIRES_IN}（600 秒）と {@link DEFAULT_POLL_INTERVAL}（5 秒）を使う。
 * `requireOpenIdScope` は {@link validateDeviceAuthorizationScope} にそのまま渡し、省略すると `openid` を必須にする。
 *
 * @spec RFC 8628 §3.1
 * @spec RFC 8628 §3.2
 * @throws {DeviceAuthorizationError} `unauthorized_client`: クライアントがデバイスコードのグラントタイプを登録していないとき。
 * @throws {DeviceAuthorizationError} `invalid_request`: `openid` を必須にしていて、`scope` がないか空白だけのとき。
 * @throws {DeviceAuthorizationError} `invalid_scope`: `openid` を必須にしていて `scope` に `openid` がないとき、または `openid` を必須にしておらず `scope` がないか空白だけのとき。
 * @throws {Error} ユーザーコードが決められた回数続けて既存のコードと衝突したとき。
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
  requireOpenIdScope?: boolean;
}): Promise<DeviceAuthorizationResponse> {
  validateDeviceGrantAllowed(input.client);

  const requestedScope = validateDeviceAuthorizationScope(input.params['scope'], {
    requireOpenIdScope: input.requireOpenIdScope,
  });
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
