/**
 * OpenID Connect Client-Initiated Backchannel Authentication (CIBA) Core 1.0 —
 * Poll モード、§10.1 / §11（トークンエンドポイント）
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * トークンエンドポイントの grant 分岐に載る状態機械。生成コードは core の
 * `validateGrantTypeSupported` より前でこれを呼び、分岐内で応答を返し切る。
 */
import type { TokenClientInfo } from '@maronn-openid-connect/core';
import { CibaGrantError } from './errors.js';
import type {
  CibaAuthenticationRequestRecord,
  CibaAuthenticationRequestStore,
} from './store.js';

/** CIBA §11: slow_down のたびにサーバー側も interval を +5 秒する。 */
export const SLOW_DOWN_INTERVAL_INCREMENT = 5;

/**
 * auth_req_id の実在性を漏らさないための単一文言。
 *
 * 「レコードが無い」「他クライアントの auth_req_id」を同じ文言にすることで
 * （CIBA §11 "invalid or was issued to another Client"）、攻撃者が他クライアントの
 * auth_req_id の実在を確かめられないようにする。
 */
const INVALID_AUTH_REQ_ID_MESSAGE =
  'The auth_req_id is invalid, expired, or was issued to another client';

/** 承認済みレコードから確定した、トークン発行に必要な情報。 */
export interface CibaGrantResult {
  subject: string;
  clientId: string;
  scope: string[];
  authTime: number;
  grantId: string;
}

/**
 * トークンエンドポイントの CIBA 分岐（CIBA §10.1 / §11、Poll モード）。
 *
 * 状態機械の判定順序（上から評価し、最初に該当したものを返す）:
 *
 * 1. `auth_req_id` 欠落 → `invalid_request`
 * 2. レコード不存在・クライアント不一致 → `invalid_grant`（同一文言・レコードは残す）
 * 3. 期限切れ → `expired_token`（レコード削除）
 * 4. ポーリング過速 → `slow_down`（interval を +5 して保存）
 * 5. pending → `authorization_pending`（lastPolledAt 更新）
 * 6. denied → `access_denied`（レコード削除。再ポーリングは invalid_grant）
 * 7. approved → 結果を返す（レコードは consume で単回使用にする）
 *
 * 期限切れをポーリング過速より先に評価するのは、期限切れレコードの interval を
 * 増やしても意味がなく、クライアントへはフロー終了を伝えるべきだから。
 * `lastPolledAt` の更新は slow_down と authorization_pending の 2 経路のみ
 * （他の結果はレコードを削除または consume するため更新対象が残らない）。
 *
 * 過剰ポーリングへ `invalid_request` を返す選択肢（§11 の MAY）は採らず、
 * device-authorization-grant と同じ slow_down 方式に統一する。
 *
 * @throws {CibaGrantError}
 */
export async function processCibaGrant(input: {
  params: Record<string, string>;
  /** 認証済みクライアント（分岐前の共有認証パイプラインが解決したもの）。 */
  client: TokenClientInfo;
  store: CibaAuthenticationRequestStore;
  now?: Date;
}): Promise<CibaGrantResult> {
  const record = await resolveCibaRecord(input.params, input.client, input.store);
  return evaluateCibaState(record, input.store, input.now ?? new Date());
}

/**
 * `auth_req_id` パラメータを取り出し、発行先クライアントのレコードを解決する。
 *
 * @throws {CibaGrantError} invalid_request / invalid_grant
 */
async function resolveCibaRecord(
  params: Record<string, string>,
  client: TokenClientInfo,
  store: CibaAuthenticationRequestStore,
): Promise<CibaAuthenticationRequestRecord> {
  const authReqId = params['auth_req_id'];
  if (authReqId === undefined || authReqId === '') {
    throw new CibaGrantError('invalid_request', 'Missing required parameter: auth_req_id');
  }
  const record = await store.findByAuthReqId(authReqId);
  if (record === null || record.clientId !== client.clientId) {
    throw new CibaGrantError('invalid_grant', INVALID_AUTH_REQ_ID_MESSAGE);
  }
  return record;
}

/**
 * CIBA §11 の状態機械を評価する。
 *
 * @throws {CibaGrantError} §11 の各状態
 */
async function evaluateCibaState(
  record: CibaAuthenticationRequestRecord,
  store: CibaAuthenticationRequestStore,
  now: Date,
): Promise<CibaGrantResult> {
  if (now.getTime() >= record.expiresAt.getTime()) {
    await store.delete(record.authReqId);
    throw new CibaGrantError(
      'expired_token',
      'The auth_req_id has expired. Start a new backchannel authentication request.',
    );
  }

  if (
    record.lastPolledAt !== null &&
    now.getTime() - record.lastPolledAt.getTime() < record.interval * 1000
  ) {
    // CIBA §11: "the interval MUST be increased by at least 5 seconds for this
    // and all subsequent requests" — サーバー側も新しい間隔を強制する。
    record.interval += SLOW_DOWN_INTERVAL_INCREMENT;
    record.lastPolledAt = now;
    await store.update(record);
    throw new CibaGrantError(
      'slow_down',
      'Polling too frequently. Increase the interval by 5 seconds.',
    );
  }

  if (record.status === 'pending') {
    record.lastPolledAt = now;
    await store.update(record);
    throw new CibaGrantError(
      'authorization_pending',
      'The authentication request is still pending',
    );
  }

  if (record.status === 'denied') {
    await store.delete(record.authReqId);
    throw new CibaGrantError('access_denied', 'The end-user denied the authentication request');
  }

  // approved: 単回使用を強制するため atomic な consume で回収する。並行
  // リデンプションでは先勝ちの 1 本だけがトークンを得て、後続は record が
  // null になり invalid_grant。
  const consumed = await store.consume(record.authReqId);
  if (
    consumed === null ||
    consumed.status !== 'approved' ||
    consumed.authTime === undefined ||
    consumed.grantId === undefined
  ) {
    throw new CibaGrantError('invalid_grant', INVALID_AUTH_REQ_ID_MESSAGE);
  }

  return {
    subject: consumed.subject,
    clientId: consumed.clientId,
    scope: consumed.approvedScope ?? consumed.scope,
    authTime: consumed.authTime,
    grantId: consumed.grantId,
  };
}
