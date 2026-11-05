/**
 * EXPERIMENTAL — device verification UI, step 3: approve or deny
 * (RFC 8628 §3.3).
 *
 * The only state-changing step of the UI, so it demands all three: an OP
 * session, the binding cookie, and the csrf_token. The device learns the
 * outcome by polling the token endpoint.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  findPendingRecordByUserCode,
  validateVerificationBinding,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { errorPage } from '../../../_oidc-provider/html';
import { readFormFields } from '../../../_oidc-provider/http';
import { deviceAuthorizationStore } from '../../../_oidc-provider/features/device-authorization-grant/store';
import { resolvers, stores } from '../../../_oidc-provider/provider';
import { buildClearedDeviceBindingCookie, parseDeviceBindingSecret } from '../../../_oidc-provider/features/device-authorization-grant/cookies';
import { parseSessionId } from '../../../_oidc-provider/cookies';
import { resolveGrantableScopes } from '../../../_oidc-provider/scopes';
import { completedScreen, invalidUserCodeScreen, verificationFailureScreen } from '../screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 承認か拒否をレコードに記録し、完了画面を返す。
 *
 * `POST /device/approve` で送られた `user_code` のデバイスについて、エンドユーザーの決定（`decision`）を記録する。
 * デバイスの承認と拒否を決める処理なので、OP のセッション、バインディング Cookie、`csrf_token` の 3 つをすべて求める。
 *
 * `decision` が `approve` なら、保留中のレコードを `approved` にしてセッションのサブジェクト、`auth_time`、新しいグラント ID を記録し、スコープを `resolveGrantableScopes()` で絞って保存する。
 * 同意とグラントも記録する。
 * `approve` 以外の値は、すべて拒否として扱い、レコードを `denied` にする。
 * どちらの場合も、バインディング Cookie を消す Cookie を付けて、デバイスに戻るよう伝える完了画面を返す。
 * デバイスは、次のポーリングで `/token` からトークンか `access_denied` を受け取る。
 *
 * `user_code` が未知、期限切れ、使用済みのどれかなら、ユーザーコードの入力フォームを 400 で返す。
 * OP のセッションがなければ 401、バインディング Cookie か `csrf_token` がないか一致しなければ 403 の OP のエラーページを返す。
 * 承認か拒否の前にレコードが決定済みになっていたときは、400 のエラーページを返す。
 *
 * @spec RFC 8628 §3.3
 */
export async function POST(request: Request): Promise<Response> {
  const form = await readFormFields(request);
  const submittedUserCode = String(form.get('user_code') ?? '');
  const csrfToken = String(form.get('csrf_token') ?? '');

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceAuthorizationStore);
  if (!record) {
    return invalidUserCodeScreen(submittedUserCode);
  }

  const sessionId = parseSessionId(request.headers.get('Cookie'));
  const session = sessionId ? await stores.browserSessionStore.get(sessionId) : undefined;
  if (!session) {
    return errorPage('Sign in again to approve this device', 401);
  }

  // 決定で検証は終わるので、バインディング Cookie を消す Cookie を用意する。
  const clearBindingCookie = buildClearedDeviceBindingCookie(record.userCode);
  try {
    await validateVerificationBinding(
      record,
      parseDeviceBindingSecret(request.headers.get('Cookie'), record.userCode),
    );

    if (String(form.get('decision') ?? '') === 'approve') {
      // レコードを承認し、トークンエンドポイントが読むサブジェクト、`auth_time`、スコープ、新しい `grantId` を記録する。
      // `csrf_token` の検証は、`approveDeviceAuthorization()` の中で行う。
      const approved = await approveDeviceAuthorization({
        record,
        store: deviceAuthorizationStore,
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
      await deviceAuthorizationStore.update(approved);

      // `/consent` と同じように同意を記録し、このクライアントの後の認可コードフローで同意画面を省けるようにする（OIDC Core 1.0 §3.1.2.4）。
      // グラントも記録し、その同意を取り消せばこれらのトークンも失効するようにする。
      await resolvers.consentResolver.recordConsent?.(
        session.subject,
        approved.clientId,
        approved.approvedScope ?? approved.scope,
      );
      if (approved.grantId) {
        await resolvers.consentResolver.recordGrant(session.subject, approved.clientId, approved.grantId);
      }
      return completedScreen({ approved: true, clientId: approved.clientId }, [clearBindingCookie]);
    }

    // `approve` 以外の値は、すべて拒否として扱う。
    await denyDeviceAuthorization({ record, store: deviceAuthorizationStore, csrfToken });
    return completedScreen({ approved: false, clientId: record.clientId }, [clearBindingCookie]);
  } catch (error) {
    return verificationFailureScreen(error);
  }
}
