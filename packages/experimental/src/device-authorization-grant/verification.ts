/**
 * OAuth 2.0 Device Authorization Grant — RFC 8628 §3.3
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * 検証 UI（`GET/POST /device`, `POST /device/login`, `POST /device/approve`）が
 * 呼ぶステップ関数群。
 *
 * ## ブラウザバインディングが CSRF 防御の主役である理由
 *
 * device フローの user_code は「フローを開始した主体」が設計上必ず知っている識別子で
 * あり、その主体こそが攻撃者になり得る。したがってレコードに紐づけただけの CSRF
 * トークンは、攻撃者自身が `POST /device` を叩いて取得できてしまい防御にならない。
 *
 * そこで user_code の照合成功時に bindingSecret を発行し、生値はブラウザだけが持つ
 * HttpOnly Cookie に、SHA-256 ハッシュのみをレコードへ保存する。`/device/login` と
 * `/device/approve` は Cookie の生値がレコードの bindingHash と一致しない限り実行
 * されない。フォージされたクロスサイト POST は被害者ブラウザの Cookie を運べない
 * （SameSite=Lax）うえ、そもそも被害者ブラウザは当該レコードの Cookie を保持して
 * いないため、トークン秘匿に依存せず遮断できる。
 *
 * authorize フローの transaction-binding が opt-in なのに対し、こちらは常時有効で
 * ある。transaction_id は通常秘匿されるためバインディングは追加ハードニングで足りるが、
 * user_code は開始者に既知であることが前提のため、これがベースライン要件になる。
 */
import { generateRandomString } from '@maronn-openid-connect/core';
import { DeviceAuthorizationError, DeviceVerificationError } from './errors.js';
import { normalizeUserCode } from './user-code.js';
import type {
  DeviceAuthorizationRecord,
  DeviceAuthorizationStore,
} from './store.js';

/** bindingSecret / csrfToken のエントロピー（256bit）。 */
const VERIFICATION_SECRET_BYTE_LENGTH = 32;

/**
 * user_code 照合の失敗理由を利用者へ区別させないための単一文言。
 *
 * 未知・期限切れ・使用済み（非 pending）を同じ文言で返すことで、有効な user_code の
 * 実在性を推測材料として渡さない（RFC 8628 §5.1）。
 */
export const INVALID_USER_CODE_MESSAGE = 'The code is invalid or has expired';

/**
 * 値の SHA-256 ハッシュを base64url で返す。
 *
 * 返す値には、パディングの `=` を付けない。
 * `bindingSecret` の生の値はブラウザの Cookie にだけあり、レコードにはこのハッシュだけを保存する。
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
 * ユーザーコードに合う、保留中で期限内のレコードを返す。
 *
 * 入力を {@link normalizeUserCode} で正規化してから探す。
 * 正規化した値が空のとき、レコードがないとき、状態が `pending` でないとき、有効期限を過ぎているときは、どれも `null` を返す。
 * 呼び出し側は理由を区別せずに、{@link INVALID_USER_CODE_MESSAGE} を付けてフォームを表示し直す。
 *
 * ストアを探す時間の差から、ユーザーコードが実在するかがわずかに漏れることはありうる。
 * ただし主な防御はエントロピー（20^8 通り）と短い有効期間であり、実在を知っても承認の操作まではできない。
 */
export async function findPendingRecordByUserCode(
  userCode: string,
  store: DeviceAuthorizationStore,
  now: Date = new Date(),
): Promise<DeviceAuthorizationRecord | null> {
  const normalized = normalizeUserCode(userCode);
  if (normalized === '') return null;
  const record = await store.findByUserCode(normalized);
  if (record === null) return null;
  if (record.status !== 'pending') return null;
  if (now.getTime() >= record.expiresAt.getTime()) return null;
  return record;
}

/**
 * バインディングと CSRF トークンを作って保存し、返す。
 *
 * `POST /device` でユーザーコードの照合に成功したときに呼び、`bindingSecret` と CSRF トークンを対にして作り直す。
 * どちらも 32 バイトの乱数である。
 * `bindingSecret` の生の値は戻り値でだけ返し（生成されたコードが Cookie に入れる）、レコードにはその SHA-256 ハッシュと CSRF トークンを保存する。
 *
 * 別のブラウザが同じユーザーコードで `POST /device` を送ると、先のブラウザのバインディングは無効になる（後から書いたほうが残る）。
 * ユーザーコードを知っている者がレコードの承認や拒否を左右できるという RFC 8628 のモデルは変わらないので、意図した機能ではなく、既知の制約として受け入れている。
 */
export async function issueVerificationBinding(
  record: DeviceAuthorizationRecord,
  store: DeviceAuthorizationStore,
): Promise<{ bindingSecret: string; csrfToken: string }> {
  const bindingSecret = generateRandomString(VERIFICATION_SECRET_BYTE_LENGTH);
  const csrfToken = generateRandomString(VERIFICATION_SECRET_BYTE_LENGTH);
  record.bindingHash = await sha256Base64Url(bindingSecret);
  record.csrfToken = csrfToken;
  await store.update(record);
  return { bindingSecret, csrfToken };
}

/**
 * `bindingSecret` がこのレコードのものか確かめる。
 *
 * `bindingSecret` には、Cookie から取り出した値を渡す。
 * レコードにバインディングがない（`bindingHash` が `null`）か、`bindingSecret` がないときは 403 を投げる。
 * バインディングがないレコードは、まだ `POST /device` を通っていないからである。
 * `bindingSecret` の SHA-256 ハッシュが保存した値と一致しないときも、403 を投げる。
 *
 * 比較は定数時間ではないが、比較にかかる時間の差から保存したハッシュの先頭を割り出しても、それに合う入力を作るにはハッシュの原像を計算する必要があるので、攻撃は成り立たない。
 *
 * @throws {DeviceVerificationError} 403: バインディングか `bindingSecret` がないとき、またはハッシュが一致しないとき。
 */
export async function validateVerificationBinding(
  record: DeviceAuthorizationRecord,
  bindingSecret: string | null | undefined,
): Promise<void> {
  if (record.bindingHash === null || !bindingSecret) {
    throw new DeviceVerificationError('Device verification binding is missing', 403);
  }
  const presented = await sha256Base64Url(bindingSecret);
  if (presented !== record.bindingHash) {
    throw new DeviceVerificationError('Device verification binding is invalid', 403);
  }
}

/**
 * フォームの `csrf_token` がレコードのものか確かめる。
 *
 * レコードに CSRF トークンがないとき、送られた値が空文字列のとき、または値が一致しないときは、403 を投げる。
 * 隠しフィールドで送る CSRF トークンは多層防御の一つで、主な防御は {@link validateVerificationBinding} なので、必ずバインディングを先に検証してから呼ぶ。
 * 比較の方法は、既存のログインと同意の画面の `validateCsrfToken` と同じ水準に揃えてある。
 * あちらを定数時間の比較に変えるときは、この機能にも同じ方針を適用する。
 *
 * @throws {DeviceVerificationError} 403: CSRF トークンがないか一致しないとき。
 */
export function validateVerificationCsrfToken(
  record: DeviceAuthorizationRecord,
  csrfToken: string,
): void {
  if (record.csrfToken === null || csrfToken === '' || csrfToken !== record.csrfToken) {
    throw new DeviceVerificationError('CSRF token mismatch', 403);
  }
}

/**
 * ログインの失敗を数え、再試行の可否と残り回数を返す。
 *
 * 失敗の回数はレコードごとに数え、`loginAttempts` を 1 増やしてレコードを更新する。
 * 回数が上限（`maxLoginAttempts`）に達したら状態を `denied` にし、そのユーザーコードでのフローを終わらせる（デバイスは次のポーリングで `access_denied` を受け取る）。
 *
 * 既知の弱点として、デバイス認可グラントを使えるクライアントを持つ攻撃者はレコードをいくらでも作れるので、合計のパスワードの試行回数に上限はない。
 * 既存の `/login`（認可リクエストのトランザクションをいくらでも始められる）にも同じ弱点があり、サブジェクトごとの試行の制限はこの関数では行わない。
 */
export async function recordDeviceLoginFailure(
  record: DeviceAuthorizationRecord,
  store: DeviceAuthorizationStore,
  maxLoginAttempts: number,
): Promise<{ canRetry: boolean; remainingAttempts: number }> {
  record.loginAttempts += 1;
  const canRetry = record.loginAttempts < maxLoginAttempts;
  if (!canRetry) {
    record.status = 'denied';
  }
  await store.update(record);
  return {
    canRetry,
    remainingAttempts: Math.max(0, maxLoginAttempts - record.loginAttempts),
  };
}

/**
 * デバイス認可を承認済みにし、更新したレコードを返す。
 *
 * `POST /device/approve` で `decision=approve` を受け取ったときに呼ぶ。
 * バインディングの検証は、呼び出し側が先に済ませておく。
 * Cookie を読むのは生成されたコードなので、この関数はレコードと CSRF トークンだけを確かめる。
 *
 * CSRF トークンが一致し、状態が `pending` なら、状態を `approved` にし、`subject`、`authTime`、`approvedScope`、`grantId` を設定し、バインディングと CSRF トークンを消してから保存する。
 * `approvedScope` には、要求された `scope` をそのまま入れる（この OP の検証の画面には、スコープの一部だけを承認する操作がない）。
 * `grantId` は 32 バイトの乱数で新しく作り、既存の失効の仕組みがグラント単位の失効をそのまま適用できるようにする。
 *
 * @throws {DeviceVerificationError} 403: CSRF トークンが一致しないとき。
 * @throws {DeviceAuthorizationError} `invalid_grant`: 状態が `pending` でないとき。
 */
export async function approveDeviceAuthorization(input: {
  record: DeviceAuthorizationRecord;
  store: DeviceAuthorizationStore;
  csrfToken: string;
  subject: string;
  authTime: number;
}): Promise<DeviceAuthorizationRecord> {
  validateVerificationCsrfToken(input.record, input.csrfToken);
  assertPending(input.record);

  input.record.status = 'approved';
  input.record.subject = input.subject;
  input.record.authTime = input.authTime;
  input.record.approvedScope = [...input.record.scope];
  input.record.grantId = generateRandomString(VERIFICATION_SECRET_BYTE_LENGTH);
  // 承認したあとは、バインディングも CSRF トークンも使わない。
  // 承認と拒否は元に戻らない遷移なので、残しておく理由のない値をレコードから消す。
  input.record.bindingHash = null;
  input.record.csrfToken = null;
  await input.store.update(input.record);
  return input.record;
}

/**
 * デバイス認可を拒否済みにし、更新したレコードを返す。
 *
 * `POST /device/approve` で `decision=deny` を受け取ったときに呼ぶ。
 * {@link approveDeviceAuthorization} と同じく CSRF トークンと状態を確かめ、通れば状態を `denied` にし、バインディングと CSRF トークンを消して保存する。
 *
 * @throws {DeviceVerificationError} 403: CSRF トークンが一致しないとき。
 * @throws {DeviceAuthorizationError} `invalid_grant`: 状態が `pending` でないとき。
 */
export async function denyDeviceAuthorization(input: {
  record: DeviceAuthorizationRecord;
  store: DeviceAuthorizationStore;
  csrfToken: string;
}): Promise<DeviceAuthorizationRecord> {
  validateVerificationCsrfToken(input.record, input.csrfToken);
  assertPending(input.record);

  input.record.status = 'denied';
  input.record.bindingHash = null;
  input.record.csrfToken = null;
  await input.store.update(input.record);
  return input.record;
}

/**
 * 状態が `pending` でなければ `invalid_grant` を投げる。
 *
 * 承認と拒否は元に戻らない遷移なので、状態が `approved` か `denied` のレコードは、検証の画面からもう一度操作できない。
 * エラーの文言は、ユーザーコードの照合に失敗したときと同じ {@link INVALID_USER_CODE_MESSAGE} である。
 *
 * @throws {DeviceAuthorizationError} `invalid_grant`: 状態が `pending` でないとき。
 */
function assertPending(record: DeviceAuthorizationRecord): void {
  if (record.status !== 'pending') {
    throw new DeviceAuthorizationError(
      'invalid_grant',
      INVALID_USER_CODE_MESSAGE,
    );
  }
}
