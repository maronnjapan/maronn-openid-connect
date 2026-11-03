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
 * クライアントがデバイス認可グラントを使えるか確かめる。
 *
 * トークンエンドポイントで、デバイスコードをトークンと引き換えるときに呼ぶ。
 * 登録したグラントタイプ（`grantTypes`）に {@link DEVICE_CODE_GRANT_TYPE} がなければ、`unauthorized_client` を投げる（RFC 6749 §5.2）。
 *
 * @spec RFC 6749 §5.2
 * @throws {DeviceAuthorizationError} `unauthorized_client`: クライアントがデバイスコードのグラントタイプを登録していないとき。
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
 * `device_code` のレコードを探し、発行先を確かめて返す。
 *
 * `device_code` パラメータがないか空文字列なら、`invalid_request` を投げる。
 * `device_code` は発行先のクライアントに結び付いている（RFC 8628 §3.4）。
 * レコードがないときも、レコードの発行先が `client` でないときも、同じ文言の `invalid_grant` を投げる。
 * 文言を同じにするのは、ほかのクライアントの `device_code` が実在するかを確かめられないようにするためである。
 *
 * @spec RFC 8628 §3.4
 * @throws {DeviceAuthorizationError} `invalid_request`: `device_code` がないとき。
 * @throws {DeviceAuthorizationError} `invalid_grant`: レコードがないとき、または別のクライアントに発行した `device_code` のとき。
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
 * 状態を判定し、承認済みなら発行に使う情報を返す。
 *
 * 判定は次の順に行い、最初に当てはまったものが結果になる（RFC 8628 §3.5）。
 * 1. 有効期限を過ぎていれば、レコードを削除して `expired_token` を投げる。
 * 2. 前回のポーリングから `interval` 秒が経っていなければ、`interval` を {@link SLOW_DOWN_INTERVAL_INCREMENT} 秒延ばし、`lastPolledAt` を `now` にして保存し、`slow_down` を投げる。
 * 3. 状態が `pending` なら、`lastPolledAt` を `now` にして保存し、`authorization_pending` を投げる。
 * 4. 状態が `denied` なら、レコードを削除して `access_denied` を投げる。
 * 5. それ以外（`approved`）なら、`consume` でレコードを取り出すと同時に削除し、トークンの発行に使う情報（{@link DeviceCodeGrantResult}）を返す。
 *
 * 取り出したレコードがないとき（並行した引き換えで先に削除されたときなど）、状態が `approved` でないとき、または `subject`、`authTime`、`grantId` のどれかがないときは、`invalid_grant` を投げる。
 * 返す `scope` は、承認したときに決めた `approvedScope` があればその値で、なければ要求された `scope` である。
 *
 * 期限切れをポーリングの間隔より先に判定するのは、期限切れのレコードの `interval` を延ばしても意味がなく、デバイスにはフローの終了を伝えるべきだからである。
 *
 * @spec RFC 8628 §3.5
 * @throws {DeviceAuthorizationError} `expired_token`: 有効期限を過ぎたとき。
 * @throws {DeviceAuthorizationError} `slow_down`: 前回のポーリングから `interval` 秒が経っていないとき。
 * @throws {DeviceAuthorizationError} `authorization_pending`: ユーザーがまだ承認も拒否もしていないとき。
 * @throws {DeviceAuthorizationError} `access_denied`: ユーザーが拒否したとき。
 * @throws {DeviceAuthorizationError} `invalid_grant`: 承認済みのレコードを取り出せなかったとき。
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
    // 間隔を 5 秒延ばしてポーリングの時刻とともに保存し、サーバー側でも新しい間隔を守らせる。
    // このリクエストと以降のすべてのリクエストで、間隔を 5 秒延ばさなければならない（RFC 8628 §3.5 の MUST）。
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

  // 状態が `approved` なら、`consume` でレコードを取り出すと同時に削除し、一度しか使えないようにする。
  // `consume` は取り出しと削除を不可分に行うので、並行して引き換えられても、最初の 1 つだけがレコードを得る。
  // 後続のリクエストは `null` を受け取り、`invalid_grant` になる。
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
 * 承認済みの `device_code` なら、発行に使う情報を返す。
 *
 * トークンエンドポイントで、グラントタイプがデバイスコードのトークンリクエストを処理する関数で、{@link validateDeviceCodeGrantAllowed}、{@link resolveDeviceCodeRecord}、{@link evaluateDeviceCodeState} を順に呼ぶだけである。
 * 承認済みのときだけ {@link DeviceCodeGrantResult} を返し、それ以外の状態では {@link DeviceAuthorizationError} を投げる。
 *
 * @spec RFC 8628 §3.4
 * @spec RFC 8628 §3.5
 * @throws {DeviceAuthorizationError} `unauthorized_client`、`invalid_request`、`invalid_grant`、`expired_token`、`slow_down`、`authorization_pending`、`access_denied`: 中で呼ぶ関数が、それぞれの条件に当たったとき。
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
