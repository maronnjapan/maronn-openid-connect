/**
 * EXPERIMENTAL — CIBA authentication device UI, approve or deny.
 *
 * The only state-changing step of the UI. It demands an OP session whose
 * subject owns the record, plus the per-record csrf_token from the
 * session-gated listing. No binding cookie is needed here: the approval is
 * already bound to the authenticated session, so knowing an auth_req_id gives
 * an attacker no step to forge.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import { approveCibaRequest, denyCibaRequest } from '@maronn-openid-connect/experimental/ciba';
import { generateRandomString } from '@maronn-openid-connect/core';
import { errorPage } from '../../../_oidc-provider/html';
import { readFormFields } from '../../../_oidc-provider/http';
import { cibaAuthenticationRequestStore } from '../../../_oidc-provider/features/ciba/store';
import { resolvers, stores } from '../../../_oidc-provider/provider';
import { parseSessionId } from '../../../_oidc-provider/cookies';
import { resolveGrantableScopes } from '../../../_oidc-provider/scopes';
import { completedScreen, verificationFailureScreen } from '../screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 承認か拒否をリクエストに記録し、完了画面を返す。
 *
 * ログインしているエンドユーザーが `POST /ciba/approve` で送った決定（`decision`）を、保留中の CIBA の認証リクエストに記録する。
 * 認証リクエストの承認と拒否を決める処理なので、リクエストの宛先と同じユーザーの OP のセッションと、セッションがあるときにだけ一覧で渡すリクエストごとの `csrf_token` の両方を求める。
 *
 * 承認では、リクエストを `approved` にしてセッションの `auth_time` と新しいグラント ID を記録し、スコープを `resolveGrantableScopes()` で絞って保存する。
 * 同意とグラントも記録する。
 * 拒否では、リクエストを `denied` にする。
 * クライアントは、次のポーリングで `/token` からトークンか `access_denied` を受け取る。
 *
 * OP のセッションがなければ 401、`decision` が `approve` でも `deny` でもなければ 400 の OP のエラーページを返す。
 * リクエストが見つからない、期限切れ、決定済み、別のユーザー宛て、`csrf_token` が一致しない、のどれかに当たると、403 の OP のエラーページを返す。
 *
 * @spec CIBA Core 1.0 §7.1
 */
export async function POST(request: Request): Promise<Response> {
  const form = await readFormFields(request);
  const authReqId = String(form.get('auth_req_id') ?? '');
  const csrfToken = String(form.get('csrf_token') ?? '');
  const decision = String(form.get('decision') ?? '');

  const sessionId = parseSessionId(request.headers.get('Cookie'));
  const session = sessionId ? await stores.browserSessionStore.get(sessionId) : undefined;
  if (!session) {
    return errorPage('Sign in again to review this request', 401);
  }

  if (decision !== 'approve' && decision !== 'deny') {
    return errorPage('invalid_request', 400, 'decision must be approve or deny');
  }

  try {
    if (decision === 'approve') {
      // リクエストを承認し、トークンエンドポイントが読む `auth_time`、スコープ、新しい `grantId` を記録する。
      // `subject` と `csrf_token` の検証は、`approveCibaRequest()` の中で行う。
      const grantId = generateRandomString(32);
      const approved = await approveCibaRequest({
        authReqId,
        subject: session.subject,
        csrfToken,
        authTime: session.authTime,
        grantId,
        store: cibaAuthenticationRequestStore,
      });

      // 承認したスコープに、スコープの方針を適用する。
      // `approveCibaRequest()` は要求されたスコープをそのまま `approvedScope` に写すので、方針は承認の後でレコードに適用して保存する。
      // トークンエンドポイントは `approvedScope` を読み、認可サーバーは要求より狭いスコープを許可してよい（RFC 6749 §3.3）。
      // 方針は `scopes.ts` の `resolveGrantableScopes()` に書く。
      approved.approvedScope = await resolveGrantableScopes(
        approved.approvedScope ?? approved.scope,
        session.subject,
      );
      await cibaAuthenticationRequestStore.update(approved);

      // `/consent` と同じように同意を記録し、このクライアントの後の認可コードフローで同意画面を省けるようにする（OIDC Core 1.0 §3.1.2.4）。
      // グラントも記録し、その同意を取り消せばこれらのトークンも失効するようにする。
      await resolvers.consentResolver.recordConsent?.(
        session.subject,
        approved.clientId,
        approved.approvedScope ?? approved.scope,
      );
      await resolvers.consentResolver.recordGrant(session.subject, approved.clientId, grantId);
      return completedScreen({ approved: true, clientId: approved.clientId });
    }

    const record = await cibaAuthenticationRequestStore.findByAuthReqId(authReqId);
    await denyCibaRequest({
      authReqId,
      subject: session.subject,
      csrfToken,
      store: cibaAuthenticationRequestStore,
    });
    return completedScreen({ approved: false, clientId: record?.clientId ?? '' });
  } catch (error) {
    return verificationFailureScreen(error);
  }
}
