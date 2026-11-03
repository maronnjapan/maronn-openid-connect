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
 * 値の SHA-256 ハッシュを base64url で返す。
 *
 * 返す値には、パディングの `=` を付けない。
 * `bindingSecret` の生の値はブラウザの Cookie にだけあり、ログイントランザクションにはこのハッシュだけを保存する。
 * ストアの内容が漏れても、ハッシュから Cookie の値を作り直すことはできない。
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
 * ログイントランザクションを作って保存し、返す。
 *
 * ログインフォームを表示するときに呼ぶ。
 * `bindingSecret` の生の値は、保存したレコードとともに戻り値でだけ返し（生成されたコードが Cookie に入れる）、レコードにはその SHA-256 ハッシュだけを保存する。
 * `id`、`csrfToken`、`bindingSecret` はどれも 32 バイトの乱数で、有効期間は 600 秒に固定している（{@link CIBA_LOGIN_TRANSACTION_TTL_SECONDS}）。
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
 * ログインの送信を検証し、そのトランザクションを返す。
 *
 * `POST /ciba/login` で受け取った値を、ログイントランザクションがあること、有効期限内であること、Cookie の `bindingSecret` の SHA-256 ハッシュが保存した値と一致すること、CSRF トークンが一致することの順に検証する。
 * どれかに失敗すると、失敗の理由を区別できないように、同じ固定の文言の 403 を投げる。
 *
 * @throws {CibaVerificationError} 403: トランザクションがない、期限切れ、`bindingSecret` がないか一致しない、CSRF トークンが空か一致しない、のどれかに当たるとき。
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
  // 入力の SHA-256 ハッシュを、保存したハッシュと比べる。
  // 比較は定数時間ではないが、比較にかかる時間の差から保存したハッシュの先頭を割り出しても、それに合う入力を作るにはハッシュの原像を計算する必要があるので、攻撃は成り立たない。
  const presented = await sha256Base64Url(input.bindingSecret);
  if (presented !== record.bindingHash) reject();
  if (input.csrfToken === '' || input.csrfToken !== record.csrfToken) reject();
  return record;
}

/**
 * ログインの失敗を数え、再試行の可否と残り回数を返す。
 *
 * 失敗の回数はログイントランザクションごとに数え、`loginAttempts` を 1 増やす。
 * 回数が上限（`maxLoginAttempts`）未満ならトランザクションを更新し、上限に達したらトランザクションを削除して、同じフォームからの再試行を打ち切る（生成されたコードは 429 で応答する）。
 *
 * 既知の弱点として、トランザクションを作り直せば、合計の試行回数に上限はなくなる。
 * 既存の `/login`（認可リクエストのトランザクションごと）と `/device/login`（レコードごと）にも同じ弱点があり、サブジェクトごとの試行の制限はこの関数では行わない。
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
 * 保留中のリクエストに新しい CSRF トークンを付けて返す。
 *
 * `subject`（OP のセッションで確定したユーザー）宛ての、保留中で期限内のレコードを取得し、レコードごとに CSRF トークンを作り直して保存してから返す。
 * CSRF トークンは、OP のセッションが必要なこの一覧の表示でしか得られないので、`auth_req_id` を知っているだけの第三者は、承認や拒否の POST を組み立てられない。
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
 * 認証リクエストを承認済みにし、更新したレコードを返す。
 *
 * `POST /ciba/approve` で `decision=approve` を受け取ったときに呼ぶ。
 * OP のセッションを確かめるのは呼び出し側で、この関数はセッションから確定したサブジェクトを `subject` で受け取り、レコードがあること、有効期限内であること、状態が `pending` であること、サブジェクトと CSRF トークンが一致することを検証する。
 *
 * 検証を通ると、状態を `approved` にし、`authTime`、`approvedScope`、`grantId` を設定し、CSRF トークンを消してから保存する。
 * `approvedScope` には、要求された `scope` をそのまま入れる（この OP の画面には、スコープの一部だけを承認する操作がない）。
 * `grantId` は呼び出し側が作って渡す。
 * 既存の失効の仕組みが、グラント単位の失効をそのまま適用できるようにするためである。
 *
 * @throws {CibaVerificationError} 403: レコードがない、期限切れ、状態が `pending` でない、サブジェクトか CSRF トークンが一致しない、のどれかに当たるとき（どれも同じ文言）。
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
  // 承認したあとは CSRF トークンを使わない。
  // 承認と拒否は元に戻らない遷移なので、残しておく理由のない値をレコードから消す。
  record.csrfToken = null;
  await input.store.update(record);
  return record;
}

/**
 * 認証リクエストを拒否済みにして保存する。
 *
 * `POST /ciba/approve` で `decision=deny` を受け取ったときに呼ぶ。
 * {@link approveCibaRequest} と同じ検証を行い、通れば状態を `denied` にし、CSRF トークンを消して保存する。
 *
 * @throws {CibaVerificationError} 403: レコードがない、期限切れ、状態が `pending` でない、サブジェクトか CSRF トークンが一致しない、のどれかに当たるとき（どれも同じ文言）。
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
 * `auth_req_id` のレコードを検証して返す。
 *
 * 承認と拒否に共通の検証を、レコードがあること、有効期限内であること、状態が `pending` であること、サブジェクトが一致すること、CSRF トークンが一致することの順に行う。
 * どれかに失敗すると、同じ文言の 403 を投げる。
 * 失敗の理由を区別できないようにして、`auth_req_id` の有効性を外から確かめる手段にしないためである。
 *
 * @throws {CibaVerificationError} 403: 上の検証のどれかに失敗したとき。
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
  // 承認と拒否は元に戻らない遷移なので、状態が `approved` か `denied` のレコードは、画面からもう一度操作できない。
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
