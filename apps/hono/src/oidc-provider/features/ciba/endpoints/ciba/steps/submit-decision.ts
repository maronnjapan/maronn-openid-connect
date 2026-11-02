import { approveCibaRequest, denyCibaRequest } from '@maronn-openid-connect/experimental/ciba';
import { generateRandomString } from '@maronn-openid-connect/core';
import { parseSessionId } from '../../../../../cookies.js';
import { resolveGrantableScopes } from '../../../../../scopes.js';
import { type CibaOutcome, type CibaDecisionSubmission, verificationFailure } from '../outcome.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'submit-decision',
  endpoint: 'ciba',
  feature: 'ciba',
  kind: 'persist',
  label: 'Approve or deny a pending request',
  spec: 'CIBA Core 1.0 §7.1 (authentication device)',
  function: 'submitCibaDecision',
  calls: ['consentResolver.recordConsent', 'consentResolver.recordGrant'],
  consumes: ['session'],
  produces: [],
  removable: false,
});

/**
 * 承認か拒否をリクエストに記録し、完了の結果を返す。
 *
 * `POST /ciba/approve` の処理である。
 * 認証リクエストの承認と拒否を決めるステップなので、リクエストの宛先と同じユーザーの OP のセッションと、セッションがあるときにだけ一覧で渡すリクエストごとの `csrf_token` の両方を求める。
 * OP のセッションがなければ `session_required`、`decision` が `approve` でも `deny` でもなければ `invalid_decision` の結果を返す。
 * リクエストが見つからない、期限切れ、決定済み、別のユーザー宛て、`csrf_token` が一致しない、のどれかに当たると、`error`（403）の結果を返す。
 *
 * 承認では、リクエストを `approved` にしてセッションの `auth_time` と新しいグラント ID を記録し、スコープを `resolveGrantableScopes()` で絞って保存する。
 * 同意とグラントも記録する。
 * 拒否では、リクエストを `denied` にする。
 * どちらの場合も、クライアントは次のポーリングで結果を受け取る。
 *
 * @spec CIBA Core 1.0 §7.1
 */
export async function submitCibaDecision(c: any, input: CibaDecisionSubmission): Promise<CibaOutcome> {
  const { authReqId, csrfToken, decision } = input;

  const browserSessionStore = c.get('browserSessionStore');
  const cibaStore = c.get('cibaAuthenticationRequestStore');
  const consentResolver = c.get('consentResolver');

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (!session) {
    return { kind: 'session_required' };
  }

  if (decision !== 'approve' && decision !== 'deny') {
    return { kind: 'invalid_decision' };
  }

  try {
    if (decision === 'approve') {
      // リクエストを承認し、トークンエンドポイントが読む `auth_time`、スコープ、新しい `grantId` を記録する。
      // `subject` と `csrf_token` の検証は、`approveCibaRequest()` の中で行う。
      const approved = await approveCibaRequest({
        authReqId,
        subject: session.subject,
        csrfToken,
        authTime: session.authTime,
        grantId: generateRandomString(32),
        store: cibaStore,
      });
      // 承認したスコープに、スコープの方針を適用する。
      // `approveCibaRequest()` は要求されたスコープをそのまま `approvedScope` に写すので、方針は承認の後でレコードに適用して保存する。
      // トークンエンドポイントは `approvedScope` を読み、認可サーバーは要求より狭いスコープを許可してよい（RFC 6749 §3.3）。
      // 方針は `scopes.ts` の `resolveGrantableScopes()` に書く。
      approved.approvedScope = await resolveGrantableScopes(
        approved.approvedScope ?? approved.scope,
        session.subject,
      );
      await cibaStore.update(approved);

      // `/consent` と同じように同意を記録し、このクライアントの後の認可コードフローで同意画面を省けるようにする（OIDC Core 1.0 §3.1.2.4）。
      // グラントも記録し、その同意を取り消せばこれらのトークンも失効するようにする。
      await consentResolver?.recordConsent?.(
        approved.subject,
        approved.clientId,
        approved.approvedScope ?? approved.scope,
      );
      await consentResolver?.recordGrant?.(approved.subject, approved.clientId, approved.grantId);
      return { kind: 'completed', approved: true, clientId: approved.clientId };
    }

    const record = await cibaStore.findByAuthReqId(authReqId);
    await denyCibaRequest({
      authReqId,
      subject: session.subject,
      csrfToken,
      store: cibaStore,
    });
    return { kind: 'completed', approved: false, clientId: record?.clientId ?? '' };
  } catch (error) {
    return verificationFailure(error);
  }
}
