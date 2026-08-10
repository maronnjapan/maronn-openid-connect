/**
 * OAuth 2.0 Device Authorization Grant — RFC 8628 §3.4 / §3.5
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * トークンエンドポイントの grant 分岐に載る状態機械。生成コードは core の
 * `validateGrantTypeSupported` より前でこれを呼び、分岐内で応答を返し切る。
 */
import { DeviceAuthorizationError } from './errors.js';
import {
  DEVICE_CODE_GRANT_TYPE,
  type DeviceAuthorizationRecord,
  type DeviceAuthorizationStore,
} from './store.js';

/** RFC 8628 §3.5: slow_down のたびにサーバー側も interval を +5 秒する。 */
export const SLOW_DOWN_INTERVAL_INCREMENT = 5;

/**
 * device_code の実在性を漏らさないための単一文言。
 *
 * 「レコードが無い」「他クライアントの device_code」を同じ文言にすることで、
 * 攻撃者が他クライアントのコードの実在を確かめられないようにする。
 */
const INVALID_DEVICE_CODE_MESSAGE =
  'The device_code is invalid, expired, or was issued to another client';

/** トークン分岐に渡す最小限のクライアント情報。 */
export interface DeviceCodeGrantClient {
  clientId: string;
  grantTypes?: string[];
}

/** 承認済みレコードから確定した、トークン発行に必要な情報。 */
export interface DeviceCodeGrantResult {
  subject: string;
  clientId: string;
  scope: string[];
  authTime: number;
  grantId: string;
}

/**
 * ステップ 1: クライアントがデバイス認可グラントを許可されているか検証する。
 *
 * @throws {DeviceAuthorizationError} unauthorized_client
 */
export function validateDeviceCodeGrantAllowed(client: DeviceCodeGrantClient): void {
  if (!(client.grantTypes ?? []).includes(DEVICE_CODE_GRANT_TYPE)) {
    throw new DeviceAuthorizationError(
      'unauthorized_client',
      'The client is not authorized to use the device_code grant',
    );
  }
}

/**
 * ステップ 2: `device_code` パラメータを取り出し、発行先クライアントのレコードを解決する。
 *
 * RFC 8628 §3.4: device_code は発行先クライアントに紐づく。存在しない場合も
 * クライアント不一致の場合も同一文言の `invalid_grant` にする。
 *
 * @throws {DeviceAuthorizationError} invalid_request / invalid_grant
 */
export async function resolveDeviceCodeRecord(
  params: Record<string, string>,
  client: DeviceCodeGrantClient,
  store: DeviceAuthorizationStore,
): Promise<DeviceAuthorizationRecord> {
  const deviceCode = params['device_code'];
  if (deviceCode === undefined || deviceCode === '') {
    throw new DeviceAuthorizationError(
      'invalid_request',
      'Missing required parameter: device_code',
    );
  }
  const record = await store.findByDeviceCode(deviceCode);
  if (record === null || record.clientId !== client.clientId) {
    throw new DeviceAuthorizationError('invalid_grant', INVALID_DEVICE_CODE_MESSAGE);
  }
  return record;
}

/**
 * ステップ 3: RFC 8628 §3.5 の状態機械を評価する。
 *
 * 判定順序（上から評価し、最初に該当したものを返す）:
 *
 * 1. 期限切れ → `expired_token`（レコード削除）
 * 2. ポーリング過速 → `slow_down`（interval を +5 して保存）
 * 3. pending → `authorization_pending`（lastPolledAt 更新）
 * 4. denied → `access_denied`（レコード削除）
 * 5. approved → 結果を返す（レコードは consume で単回使用にする）
 *
 * 期限切れをポーリング過速より先に評価するのは、期限切れレコードに対して interval を
 * 増やしても意味がなく、デバイスへはフロー終了を伝えるべきだから。
 *
 * @throws {DeviceAuthorizationError} §3.5 の各状態
 */
export async function evaluateDeviceCodeState(
  record: DeviceAuthorizationRecord,
  store: DeviceAuthorizationStore,
  now: Date = new Date(),
): Promise<DeviceCodeGrantResult> {
  if (now.getTime() >= record.expiresAt.getTime()) {
    await store.delete(record.deviceCode);
    throw new DeviceAuthorizationError(
      'expired_token',
      'The device_code has expired. Start a new device authorization request.',
    );
  }

  if (
    record.lastPolledAt !== null &&
    now.getTime() - record.lastPolledAt.getTime() < record.interval * 1000
  ) {
    // RFC 8628 §3.5: "the interval MUST be increased by 5 seconds for this and
    // all subsequent requests" — サーバー側も新しい間隔を強制する。
    record.interval += SLOW_DOWN_INTERVAL_INCREMENT;
    record.lastPolledAt = now;
    await store.update(record);
    throw new DeviceAuthorizationError(
      'slow_down',
      'Polling too frequently. Increase the interval by 5 seconds.',
    );
  }

  if (record.status === 'pending') {
    record.lastPolledAt = now;
    await store.update(record);
    throw new DeviceAuthorizationError(
      'authorization_pending',
      'The authorization request is still pending',
    );
  }

  if (record.status === 'denied') {
    await store.delete(record.deviceCode);
    throw new DeviceAuthorizationError(
      'access_denied',
      'The end-user denied the authorization request',
    );
  }

  // approved: 単回使用を強制するため atomic な consume で回収する。並行リデンプション
  // では先勝ちの 1 本だけがトークンを得て、後続は record が null になり invalid_grant。
  const consumed = await store.consume(record.deviceCode);
  if (
    consumed === null ||
    consumed.status !== 'approved' ||
    consumed.subject === undefined ||
    consumed.authTime === undefined ||
    consumed.grantId === undefined
  ) {
    throw new DeviceAuthorizationError('invalid_grant', INVALID_DEVICE_CODE_MESSAGE);
  }

  return {
    subject: consumed.subject,
    clientId: consumed.clientId,
    scope: consumed.approvedScope ?? consumed.scope,
    authTime: consumed.authTime,
    grantId: consumed.grantId,
  };
}

/**
 * 合成関数: トークンエンドポイントのデバイスコード分岐（RFC 8628 §3.4 / §3.5）。
 *
 * 承認済みのときだけ {@link DeviceCodeGrantResult} を返し、それ以外の状態は
 * {@link DeviceAuthorizationError} を throw する。
 *
 * @throws {DeviceAuthorizationError}
 */
export async function processDeviceCodeGrant(input: {
  params: Record<string, string>;
  client: DeviceCodeGrantClient;
  store: DeviceAuthorizationStore;
  now?: Date;
}): Promise<DeviceCodeGrantResult> {
  validateDeviceCodeGrantAllowed(input.client);
  const record = await resolveDeviceCodeRecord(input.params, input.client, input.store);
  return evaluateDeviceCodeState(record, input.store, input.now);
}
