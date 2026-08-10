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
 * SHA-256 ハッシュを Base64URL で返す。
 *
 * bindingSecret の生値はブラウザの Cookie にのみ存在し、レコードにはこのハッシュ
 * だけを保存する。ストアが漏洩しても Cookie を再構成できない。
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
 * user_code を正規化して照合し、承認可能な pending レコードだけを返す。
 *
 * 未知・期限切れ・非 pending はすべて null。呼び出し側は理由を区別せず
 * {@link INVALID_USER_CODE_MESSAGE} でフォームを再表示する。
 *
 * 照合のタイミング差（ストア検索由来）は user_code の実在性をわずかに漏らし得るが、
 * 主防御はエントロピー（20^8）と短い TTL であり、実在を知っても承認操作には至れない。
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
 * `POST /device` の照合成功時に、ブラウザバインディングと CSRF トークンを
 * ペアで発行・回転する。
 *
 * bindingSecret の生値は戻り値としてのみ返し（生成コードが Cookie に載せる）、
 * レコードへは SHA-256 ハッシュだけを保存する。
 *
 * 別ブラウザが同じ user_code で `POST /device` すると先のブラウザのバインディングは
 * 無効になる（last-writer-wins）。user_code を知る者はレコードの承認 / 拒否を
 * 左右できるという RFC 8628 のモデルを変えるものではないため、機能ではなく制約と
 * して受け入れる。
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
 * Cookie から取り出した bindingSecret がこのレコードのものかを検証する。
 *
 * 照合は「入力の SHA-256 ハッシュ vs 保存ハッシュ」の比較なので、比較のタイミング差
 * から保存値の前方一致を積み上げても原像計算が必要になり成立しない。
 *
 * バインディング未発行（`bindingHash === null`）のレコードは、まだ `POST /device` を
 * 通っていないということなので拒否する（transaction-binding の後方互換スキップとは
 * 異なり、ここでは常時必須）。
 *
 * @throws {DeviceVerificationError} 403
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
 * hidden フィールドの csrf_token を照合する（多層防御）。
 *
 * 主防御は {@link validateVerificationBinding} なので、常に binding を先に検証して
 * から呼ぶこと。比較の定数時間化は既存 login / consent の `validateCsrfToken` と
 * 同じ水準に揃えてある（`tasks/p3-csrf-token-constant-time-comparison.md` の
 * 適用範囲に本機能も含める）。
 *
 * @throws {DeviceVerificationError} 403
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
 * デバイス用ログインの失敗をレコード単位で計数する。
 *
 * 上限を超えたレコードは `denied` へ遷移させ、そのコードでのフローを終わらせる
 * （デバイス側は次のポーリングで `access_denied` を受け取る）。
 *
 * 既知の残存面: device グラントを許可されたクライアントを持つ攻撃者はレコードを
 * 無制限に発行できるため、集計上のパスワード試行回数は無制限になる。これは既存
 * `/login` ルート（auth transaction を無制限に開始できる）と同一の残存面であり、
 * subject 単位のスロットリングは
 * `tasks/p2-login-attempt-throttling-subject-scope.md` の責務とする。
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
 * 承認（`POST /device/approve` の `decision=approve`）。
 *
 * バインディング検証は呼び出し側が先に済ませておくこと（生成コードは Cookie を
 * 読む責務を持つため、この関数はレコードと CSRF トークンだけを見る）。
 *
 * `approvedScope` は要求 scope をそのまま採用する（本 OP の検証 UI は scope の
 * 部分承認を提供しない）。`grantId` を新規発行し、既存の revocation 機構が
 * grant 単位失効をそのまま適用できるようにする。
 *
 * @throws {DeviceVerificationError} CSRF 不一致 (403)
 * @throws {DeviceAuthorizationError} レコードが pending でない (invalid_grant)
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
  // 承認後はバインディングも CSRF トークンも用済み。承認 / 拒否は一方向遷移なので、
  // 残しておく理由がない値をレコードから落とす。
  input.record.bindingHash = null;
  input.record.csrfToken = null;
  await input.store.update(input.record);
  return input.record;
}

/**
 * 拒否（`POST /device/approve` の `decision=deny`）。
 *
 * @throws {DeviceVerificationError} CSRF 不一致 (403)
 * @throws {DeviceAuthorizationError} レコードが pending でない (invalid_grant)
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
 * 承認 / 拒否は一方向遷移とする。`approved` / `denied` になったレコードは
 * 検証 UI から再度操作できない。
 */
function assertPending(record: DeviceAuthorizationRecord): void {
  if (record.status !== 'pending') {
    throw new DeviceAuthorizationError(
      'invalid_grant',
      INVALID_USER_CODE_MESSAGE,
    );
  }
}
