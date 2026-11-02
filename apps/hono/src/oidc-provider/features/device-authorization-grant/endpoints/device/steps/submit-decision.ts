import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  findPendingRecordByUserCode,
  validateVerificationBinding,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { buildClearedDeviceBindingCookie, parseDeviceBindingSecret } from '../../../cookies.js';
import { parseSessionId } from '../../../../../cookies.js';
import { resolveGrantableScopes } from '../../../../../scopes.js';
import { type DeviceOutcome, type DeviceDecisionSubmission, verificationFailure } from '../outcome.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'submit-decision',
  endpoint: 'device',
  feature: 'device-authorization-grant',
  kind: 'persist',
  label: 'デバイスを承認または拒否する',
  spec: 'RFC 8628 §3.3',
  function: 'submitDeviceDecision',
  calls: ['consentResolver.recordConsent', 'consentResolver.recordGrant'],
  consumes: ['record', 'bindingCookie', 'session'],
  produces: [],
  removable: false,
});

/**
 * 承認か拒否をレコードに記録し、完了の結果を返す。
 *
 * `POST /device/approve` の処理である。
 * デバイスの承認と拒否を決めるステップなので、OP のセッション、バインディング Cookie、`csrf_token` の 3 つをすべて求める。
 * `user_code` が保留中のレコードに一致しなければ `invalid_user_code`、OP のセッションがなければ `session_required` の結果を返す。
 * バインディング Cookie か `csrf_token` がないか一致しなければ、`error`（403）の結果を返す。
 *
 * `decision` が `approve` なら、レコードを `approved` にしてセッションのサブジェクト、`auth_time`、新しいグラント ID を記録し、スコープを `resolveGrantableScopes()` で絞って保存する。
 * 同意とグラントも記録する。
 * `approve` 以外の値は、すべて拒否として扱い、レコードを `denied` にする。
 * どちらの場合も、バインディング Cookie を消す Cookie を持つ `completed` の結果を返す。
 * デバイスは、次のポーリングでトークンか `access_denied` を受け取る。
 *
 * @spec RFC 8628 §3.3
 */
export async function submitDeviceDecision(
  c: any,
  input: DeviceDecisionSubmission,
): Promise<DeviceOutcome> {
  const { userCode: submittedUserCode, csrfToken, decision } = input;

  const deviceStore = c.get('deviceAuthorizationStore');
  const browserSessionStore = c.get('browserSessionStore');
  const consentResolver = c.get('consentResolver');

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceStore);
  if (!record) {
    return { kind: 'invalid_user_code', userCode: submittedUserCode };
  }

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (!session) {
    return { kind: 'session_required' };
  }

  const clearCookie = buildClearedDeviceBindingCookie(record.userCode);
  try {
    await validateVerificationBinding(
      record,
      parseDeviceBindingSecret(c.req.header('Cookie') ?? null, record.userCode),
    );

    if (decision === 'approve') {
      // レコードを承認し、トークンエンドポイントが読むサブジェクト、`auth_time`、スコープ、新しい `grantId` を記録する。
      // `csrf_token` の検証は、`approveDeviceAuthorization()` の中で行う。
      const approved = await approveDeviceAuthorization({
        record,
        store: deviceStore,
        csrfToken,
        subject: session.subject,
        authTime: session.authTime,
      });

      // 承認したスコープに、スコープの方針を適用する。
      // `approveDeviceAuthorization()` は要求されたスコープをそのまま `approvedScope` に写すので、方針は承認の後でレコードに適用して保存する。
      // トークンエンドポイントは `approvedScope` を読み、認可サーバーは要求より狭いスコープを許可してよい（RFC 6749 §3.3）。
      // 方針は `scopes.ts` の `resolveGrantableScopes()` に書く。
      approved.approvedScope = await resolveGrantableScopes(
        approved.approvedScope ?? approved.scope,
        session.subject,
      );
      await deviceStore.update(approved);

      // `/consent` と同じように同意を記録し、このクライアントの後の認可コードフローで同意画面を省けるようにする（OIDC Core 1.0 §3.1.2.4）。
      // グラントも記録し、その同意を取り消せばこれらのトークンも失効するようにする。
      await consentResolver?.recordConsent?.(
        approved.subject,
        approved.clientId,
        approved.approvedScope ?? approved.scope,
      );
      await consentResolver?.recordGrant?.(approved.subject, approved.clientId, approved.grantId);
      return { kind: 'completed', approved: true, clientId: approved.clientId, cookies: [clearCookie] };
    }

    await denyDeviceAuthorization({ record, store: deviceStore, csrfToken });
    return { kind: 'completed', approved: false, clientId: record.clientId, cookies: [clearCookie] };
  } catch (error) {
    return verificationFailure(error);
  }
}
