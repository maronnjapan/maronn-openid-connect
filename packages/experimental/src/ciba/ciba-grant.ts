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
import { CIBA_GRANT_TYPE } from './store.js';
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
 * 承認済みの `auth_req_id` なら、発行に使う情報を返す。
 *
 * トークンエンドポイントで、グラントタイプが CIBA のトークンリクエストを `poll` モードで処理する。
 * `client` には、分岐の前の共通のパイプラインで認証したクライアントを渡す。
 *
 * 判定は次の順に行い、最初に当てはまったものが結果になる。
 * 1. クライアントが CIBA のグラントタイプを登録していなければ、`unauthorized_client` を投げる（{@link validateCibaGrantAllowed}）。
 * 2. `auth_req_id` がなければ、`invalid_request` を投げる。
 * 3. レコードがないか、別のクライアントに発行した `auth_req_id` なら、同じ文言の `invalid_grant` を投げ、レコードは変えずに残す。
 * 4. 有効期限を過ぎていれば、レコードを削除して `expired_token` を投げる。
 * 5. 前回のポーリングから `interval` 秒が経っていなければ、`interval` を 5 秒延ばして保存し、`slow_down` を投げる。
 * 6. 状態が `pending` なら、`lastPolledAt` を更新して `authorization_pending` を投げる。
 * 7. 状態が `denied` なら、レコードを削除して `access_denied` を投げる（再びポーリングすると `invalid_grant` になる）。
 * 8. 状態が `approved` なら、`consume` でレコードを取り出すと同時に削除し、トークンの発行に使う情報（{@link CibaGrantResult}）を返す。
 *
 * 期限切れをポーリングの間隔より先に判定するのは、期限切れのレコードの `interval` を延ばしても意味がなく、クライアントにはフローの終了を伝えるべきだからである。
 *
 * `lastPolledAt` を更新するのは、`slow_down` と `authorization_pending` のときだけである。
 * `expired_token`、`access_denied`、トークンの発行ではレコードを削除するので、更新するレコードが残らない。
 *
 * 速すぎるポーリングに `invalid_request` を返す選択肢（CIBA §11 の MAY）は採らず、デバイス認可グラントと同じ `slow_down` の方式に揃える。
 *
 * @spec CIBA Core 1.0 §10.1
 * @spec CIBA Core 1.0 §11
 * @throws {CibaGrantError} `unauthorized_client`: クライアントが CIBA のグラントタイプを登録していないとき。
 * @throws {CibaGrantError} `invalid_request`: `auth_req_id` がないとき。
 * @throws {CibaGrantError} `invalid_grant`: レコードがないとき、別のクライアントに発行した `auth_req_id` のとき、または承認済みのレコードを取り出せなかったとき。
 * @throws {CibaGrantError} `expired_token`: 有効期限を過ぎたとき。
 * @throws {CibaGrantError} `slow_down`: 前回のポーリングから `interval` 秒が経っていないとき。
 * @throws {CibaGrantError} `authorization_pending`: ユーザーがまだ承認も拒否もしていないとき。
 * @throws {CibaGrantError} `access_denied`: ユーザーが拒否したとき。
 */
export async function processCibaGrant(input: {
  params: Record<string, string>;
  /** 認証済みクライアント（分岐前の共有認証パイプラインが解決したもの）。 */
  client: TokenClientInfo;
  store: CibaAuthenticationRequestStore;
  now?: Date;
}): Promise<CibaGrantResult> {
  validateCibaGrantAllowed(input.client);
  const record = await resolveCibaRecord(input.params, input.client, input.store);
  return evaluateCibaState(record, input.store, input.now ?? new Date());
}

/**
 * クライアントの `grantTypes` に CIBA があるか確かめる。
 *
 * `grantTypes` に {@link CIBA_GRANT_TYPE} がなければ、`unauthorized_client` を投げる（RFC 6749 §5.2）。
 * バックチャネル認証エンドポイントも受け付けるときに同じ検証を行うが、`auth_req_id` を発行してからトークンと引き換えるまでのあいだに、クライアントの登録から CIBA が外れることがあるので、引き換えるときにも確かめる。
 * デバイス認可グラントの `validateDeviceCodeGrantAllowed` と同じ位置づけの検証である。
 *
 * @spec RFC 6749 §5.2
 * @throws {CibaGrantError} `unauthorized_client`: クライアントが CIBA のグラントタイプを登録していないとき。
 */
export function validateCibaGrantAllowed(client: TokenClientInfo): void {
  if (!(client.grantTypes ?? []).includes(CIBA_GRANT_TYPE)) {
    throw new CibaGrantError(
      'unauthorized_client',
      'The client is not authorized to use the CIBA grant',
    );
  }
}

/**
 * `auth_req_id` のレコードを探し、発行先を確かめて返す。
 *
 * `auth_req_id` パラメータがないか空文字列なら、`invalid_request` を投げる。
 * レコードがないか、レコードの発行先が `client` でなければ、同じ文言の `invalid_grant` を投げる。
 * 文言を同じにするのは、ほかのクライアントの `auth_req_id` が実在するかを確かめられないようにするためである（CIBA §11）。
 *
 * @spec CIBA Core 1.0 §11
 * @throws {CibaGrantError} `invalid_request`: `auth_req_id` がないとき。
 * @throws {CibaGrantError} `invalid_grant`: レコードがないとき、または別のクライアントに発行した `auth_req_id` のとき。
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
 * 状態を判定し、承認済みなら発行に使う情報を返す。
 *
 * 判定は次の順に行う（CIBA §11）。
 * - 有効期限を過ぎていれば、レコードを削除して `expired_token` を投げる。
 * - 前回のポーリングから `interval` 秒が経っていなければ、`interval` を {@link SLOW_DOWN_INTERVAL_INCREMENT} 秒延ばし、`lastPolledAt` を `now` にして保存し、`slow_down` を投げる。
 * - 状態が `pending` なら、`lastPolledAt` を `now` にして保存し、`authorization_pending` を投げる。
 * - 状態が `denied` なら、レコードを削除して `access_denied` を投げる。
 * - それ以外（`approved`）なら、`consume` でレコードを取り出すと同時に削除し、トークンの発行に使う情報を返す。
 *
 * 取り出したレコードがないとき（並行した引き換えで先に削除されたときなど）、状態が `approved` でないとき、または `authTime` か `grantId` がないときは、`invalid_grant` を投げる。
 * 返す `scope` は、承認したときに決めた `approvedScope` があればその値で、なければ要求された `scope` である。
 *
 * @spec CIBA Core 1.0 §11
 * @throws {CibaGrantError} `expired_token`、`slow_down`、`authorization_pending`、`access_denied`: 上の判定のそれぞれに当たるとき。
 * @throws {CibaGrantError} `invalid_grant`: 承認済みのレコードを取り出せなかったとき。
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
    // 間隔を 5 秒延ばしてポーリングの時刻とともに保存し、サーバー側でも新しい間隔を守らせる。
    // このリクエストと以降のすべてのリクエストで、間隔を少なくとも 5 秒延ばさなければならない（CIBA §11 の MUST）。
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

  // 状態が `approved` なら、`consume` でレコードを取り出すと同時に削除し、一度しか使えないようにする。
  // `consume` は取り出しと削除を不可分に行うので、並行して引き換えられても、最初の 1 つだけがレコードを得る。
  // 後続のリクエストは `null` を受け取り、`invalid_grant` になる。
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
