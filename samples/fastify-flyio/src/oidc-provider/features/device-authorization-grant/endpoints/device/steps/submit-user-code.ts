import { findPendingRecordByUserCode, issueVerificationBinding } from '@maronn-openid-connect/experimental/device-authorization-grant';
import { buildDeviceBindingCookie } from '../../../cookies.js';
import { parseSessionId } from '../../../../../cookies.js';
import { resolveGrantableScopes } from '../../../../../scopes.js';
import { type DeviceOutcome, remainingTtlSeconds } from '../outcome.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'submit-user-code',
  endpoint: 'device',
  feature: 'device-authorization-grant',
  kind: 'resolve',
  label: 'user_code を照合し、このブラウザを結び付ける',
  spec: 'RFC 8628 §3.3',
  function: 'submitDeviceUserCode',
  consumes: [],
  produces: ['record', 'bindingCookie'],
  removable: false,
});

/**
 * ユーザーコードを照合し、ログインか承認の結果を返す。
 *
 * `POST /device` の処理である。
 * `submittedUserCode` が保留中のレコードに一致しなければ、`invalid_user_code` の結果を返す。
 * 一致すれば、バインディングの秘密の値と CSRF トークンを作り直してレコードに保存し、秘密の値をバインディング Cookie にしてこのブラウザに渡す。
 * OP のセッションがあれば承認画面（`approval`）の結果を、なければログインフォーム（`login`）の結果を、どちらもバインディング Cookie を付けて返す。
 *
 * バインディング Cookie を作るのはこのステップだけなので、`csrf_token` を最初に渡すのもこのステップである。
 * 後のステップ（ログインと承認）は、どれもこの Cookie を求める。
 *
 * @spec RFC 8628 §3.3
 */
export async function submitDeviceUserCode(c: any, submittedUserCode: string): Promise<DeviceOutcome> {
  const deviceStore = c.get('deviceAuthorizationStore');
  const browserSessionStore = c.get('browserSessionStore');

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceStore);
  if (!record) {
    return { kind: 'invalid_user_code', userCode: submittedUserCode };
  }

  // バインディングの秘密の値と CSRF トークンを、まとめて作り直す。
  // 別のブラウザが同じ `user_code` を送信すると、バインディングはそのブラウザに移る（最後に送信したものが勝つ）。
  // 識別子を他人と共有できる設計のフローでは、避けられない性質である。
  const { bindingSecret, csrfToken } = await issueVerificationBinding(record, deviceStore);
  const cookie = buildDeviceBindingCookie(
    record.userCode,
    bindingSecret,
    remainingTtlSeconds(record),
  );

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (session) {
    return {
      kind: 'approval',
      userCode: record.userCodeDisplay,
      csrfToken,
      clientId: record.clientId,
      scopes: await resolveGrantableScopes(record.scope, session.subject),
      cookies: [cookie],
    };
  }

  return {
    kind: 'login',
    userCode: record.userCodeDisplay,
    csrfToken,
    cookies: [cookie],
  };
}
