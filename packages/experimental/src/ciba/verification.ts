/**
 * OpenID Connect Client-Initiated Backchannel Authentication (CIBA) Core 1.0 —
 * Poll モード、認証デバイス UI
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * 認証デバイス UI（`GET /ciba`, `POST /ciba/login`, `POST /ciba/approve`）が呼ぶ
 * ステップ関数群。CIBA Core は認証デバイスへの到達手段とユーザー認証方法を仕様の
 * 対象外としており（§7.1）、これは「OP がホストするブラウザ UI」という本機能の
 * 実装判断に属する層である。
 *
 * ## ログイントランザクションがログインフォームを守る理由
 *
 * ログイン成功は OP セッションという CIBA 外にも及ぶ状態（SSO / prompt=none）を
 * 作るため、クロスサイトの偽造 POST で攻撃者アカウントのセッションを被害者
 * ブラウザへ植え付けるログイン CSRF を防ぐ必要がある。フォーム埋め込みトークン
 * だけでは、攻撃者が自分で `GET /ciba` を叩いて有効な `login_transaction_id` +
 * CSRF の対を入手し偽造フォームへ埋め込めるため足りない。そこでフォーム表示時に
 * bindingSecret を発行し、生値はブラウザだけが持つ HttpOnly Cookie に、SHA-256
 * ハッシュのみをトランザクションへ保存する。偽造 POST は被害者ブラウザに
 * binding Cookie が無いため、トークンの秘匿に依存せず遮断できる
 * （`/device/login` の「セッションを確立するステップは binding で守る」原則と同じ）。
 *
 * ## 承認操作に binding Cookie を要求しない理由
 *
 * CIBA の承認は認証済み OP セッションの subject とレコード subject の一致で
 * 束縛されており、レコードの CSRF トークンもセッション必須の一覧表示でしか
 * 得られない。`auth_req_id` を知っていてもセッションが無ければ承認操作は一切
 * できないため、Device Flow の bindingSecret Cookie に相当する仕組みは要らない。
 */
import { generateRandomString } from '@maronn-openid-connect/core';
import { CibaVerificationError } from './errors.js';
import {
  CIBA_LOGIN_TRANSACTION_TTL_SECONDS,
  type CibaAuthenticationRequestRecord,
  type CibaAuthenticationRequestStore,
  type CibaLoginTransactionRecord,
  type CibaLoginTransactionStore,
} from './store.js';

/** bindingSecret / csrfToken / grantId 系シークレットのエントロピー（256bit）。 */
const VERIFICATION_SECRET_BYTE_LENGTH = 32;

/**
 * ログイン検証の失敗理由（不存在・期限切れ・binding 不一致・CSRF 不一致）を
 * 区別させないための単一文言。
 */
const INVALID_LOGIN_SUBMISSION_MESSAGE = 'The sign-in request could not be verified';

/**
 * 承認 / 拒否の失敗理由（不存在・期限切れ・subject 不一致・CSRF 不一致・
 * 既決定）を区別させないための単一文言。`auth_req_id` の有効性を外部から
 * 確かめるオラクルにしない。
 */
const INVALID_APPROVAL_MESSAGE = 'The authentication request could not be verified';

/**
 * SHA-256 ハッシュを Base64URL で返す。
 *
 * bindingSecret の生値はブラウザの Cookie にのみ存在し、トランザクションには
 * このハッシュだけを保存する。ストアが漏洩しても Cookie を再構成できない。
 */
async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let binary = '';
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * ログインフォーム表示時にログイントランザクションを発行する。
 *
 * bindingSecret の生値は戻り値としてのみ返し（生成コードが Cookie に載せる）、
 * レコードへは SHA-256 ハッシュだけを保存する。TTL は 600 秒固定
 * （{@link CIBA_LOGIN_TRANSACTION_TTL_SECONDS}）。
 */
export async function createCibaLoginTransaction(
  store: CibaLoginTransactionStore,
): Promise<{ record: CibaLoginTransactionRecord; bindingSecret: string }> {
  const bindingSecret = generateRandomString(VERIFICATION_SECRET_BYTE_LENGTH);
  const record: CibaLoginTransactionRecord = {
    id: generateRandomString(VERIFICATION_SECRET_BYTE_LENGTH),
    csrfToken: generateRandomString(VERIFICATION_SECRET_BYTE_LENGTH),
    bindingHash: await sha256Base64Url(bindingSecret),
    loginAttempts: 0,
    expiresAt: new Date(Date.now() + CIBA_LOGIN_TRANSACTION_TTL_SECONDS * 1000),
  };
  await store.save(record);
  return { record, bindingSecret };
}

/**
 * `POST /ciba/login` の提出内容を検証する。
 *
 * binding Cookie 生値のハッシュ一致 → CSRF 一致の順で検証する。不存在・
 * 期限切れ・binding 不一致・CSRF 不一致はすべて同じ 403 の固定文言で拒否し、
 * 失敗理由を区別させない。
 *
 * @throws {CibaVerificationError} 403
 */
export async function validateCibaLoginSubmission(input: {
  transactionId: string;
  csrfToken: string;
  /** Cookie から取り出した bindingSecret の生値。 */
  bindingSecret: string | null | undefined;
  store: CibaLoginTransactionStore;
  now?: Date;
}): Promise<CibaLoginTransactionRecord> {
  const reject: () => never = () => {
    throw new CibaVerificationError(INVALID_LOGIN_SUBMISSION_MESSAGE, 403);
  };
  const record = await input.store.findById(input.transactionId);
  if (record === null) reject();
  const now = input.now ?? new Date();
  if (now.getTime() >= record.expiresAt.getTime()) reject();
  if (!input.bindingSecret) reject();
  // 照合は「入力の SHA-256 ハッシュ vs 保存ハッシュ」の比較なので、比較の
  // タイミング差から保存値の前方一致を積み上げても原像計算が必要になり成立しない。
  const presented = await sha256Base64Url(input.bindingSecret);
  if (presented !== record.bindingHash) reject();
  if (input.csrfToken === '' || input.csrfToken !== record.csrfToken) reject();
  return record;
}

/**
 * ログイン失敗をトランザクション単位で計数する。
 *
 * 上限に達したトランザクションは削除し、同じフォームからの再試行を打ち切る
 * （生成コードは 429 を返す）。既知の残存面: トランザクションを再発行すれば
 * 集計上の試行回数は無制限になる。これは既存 `/login`（auth transaction 単位）・
 * `/device/login`（レコード単位）と同一の残存面で、subject 単位のスロットリングは
 * 別タスクの責務とする。
 */
export async function recordCibaLoginFailure(
  record: CibaLoginTransactionRecord,
  store: CibaLoginTransactionStore,
  maxLoginAttempts: number,
): Promise<{ canRetry: boolean; remainingAttempts: number }> {
  record.loginAttempts += 1;
  const canRetry = record.loginAttempts < maxLoginAttempts;
  if (canRetry) {
    await store.update(record);
  } else {
    await store.delete(record.id);
  }
  return {
    canRetry,
    remainingAttempts: Math.max(0, maxLoginAttempts - record.loginAttempts),
  };
}

/**
 * セッション subject 宛の保留中認証リクエストを一覧し、レコードごとの CSRF
 * トークンを発行・回転して保存する。
 *
 * CSRF トークンはこの一覧表示（OP セッション必須）でしか得られないため、
 * `auth_req_id` を知っているだけの第三者は承認 / 拒否の POST を組み立てられない。
 */
export async function listPendingCibaRequests(input: {
  subject: string;
  store: CibaAuthenticationRequestStore;
}): Promise<CibaAuthenticationRequestRecord[]> {
  const pending = await input.store.listPendingBySubject(input.subject);
  for (const record of pending) {
    record.csrfToken = generateRandomString(VERIFICATION_SECRET_BYTE_LENGTH);
    await input.store.update(record);
  }
  return pending;
}

/**
 * 承認（`POST /ciba/approve` の `decision=approve`）。
 *
 * OP セッションの確認は呼び出し側の責務で、この関数はセッションから確定した
 * subject を受け取り、レコードの subject との一致・CSRF 一致・期限内・pending で
 * あることを検証する。`approvedScope` は要求 scope をそのまま採用する
 * （本 OP の UI は scope の部分承認を提供しない）。`grantId` は呼び出し側が
 * 発行して渡し、既存の revocation 機構が grant 単位失効をそのまま適用できる
 * ようにする。
 *
 * @throws {CibaVerificationError} 403（不存在・期限切れ・subject 不一致・
 *   CSRF 不一致・既決定のいずれも同一文言）
 */
export async function approveCibaRequest(input: {
  authReqId: string;
  /** OP セッションから確定した subject。レコードと不一致なら拒否。 */
  subject: string;
  csrfToken: string;
  /** 承認時刻として ID トークンの auth_time に載る値（epoch 秒）。 */
  authTime: number;
  grantId: string;
  store: CibaAuthenticationRequestStore;
  now?: Date;
}): Promise<CibaAuthenticationRequestRecord> {
  const record = await resolveApprovableRecord(input);
  record.status = 'approved';
  record.authTime = input.authTime;
  record.approvedScope = [...record.scope];
  record.grantId = input.grantId;
  // 承認後は CSRF トークンは用済み。承認 / 拒否は一方向遷移なので、残して
  // おく理由がない値をレコードから落とす。
  record.csrfToken = null;
  await input.store.update(record);
  return record;
}

/**
 * 拒否（`POST /ciba/approve` の `decision=deny`）。
 *
 * @throws {CibaVerificationError} 403
 */
export async function denyCibaRequest(input: {
  authReqId: string;
  subject: string;
  csrfToken: string;
  store: CibaAuthenticationRequestStore;
  now?: Date;
}): Promise<void> {
  const record = await resolveApprovableRecord(input);
  record.status = 'denied';
  record.csrfToken = null;
  await input.store.update(record);
}

/**
 * 承認 / 拒否の共通検証。失敗はすべて同一文言の 403 に落とす。
 *
 * @throws {CibaVerificationError} 403
 */
async function resolveApprovableRecord(input: {
  authReqId: string;
  subject: string;
  csrfToken: string;
  store: CibaAuthenticationRequestStore;
  now?: Date;
}): Promise<CibaAuthenticationRequestRecord> {
  const reject: () => never = () => {
    throw new CibaVerificationError(INVALID_APPROVAL_MESSAGE, 403);
  };
  const record = await input.store.findByAuthReqId(input.authReqId);
  if (record === null) reject();
  const now = input.now ?? new Date();
  if (now.getTime() >= record.expiresAt.getTime()) reject();
  // 承認 / 拒否は一方向遷移。approved / denied になったレコードは UI から
  // 再度操作できない。
  if (record.status !== 'pending') reject();
  if (record.subject !== input.subject) reject();
  if (
    record.csrfToken === null ||
    input.csrfToken === '' ||
    input.csrfToken !== record.csrfToken
  ) {
    reject();
  }
  return record;
}
