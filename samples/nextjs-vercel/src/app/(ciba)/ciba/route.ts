/**
 * EXPERIMENTAL — CIBA authentication device UI, entry (CIBA Core 1.0 §7.1).
 *
 * CIBA leaves the authentication device — how the user is reached and how they
 * authenticate — outside the specification. This UI is an OP-hosted page the
 * user visits themselves: sign in at /ciba, review the pending requests
 * addressed to you (client, scopes, binding_message), approve or deny. The
 * consumption device learns the outcome only by polling the token endpoint.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import { createCibaLoginTransaction } from '@maronn-openid-connect/experimental/ciba';
import { cibaLoginTransactionStore } from '../../_oidc-provider/features/ciba/store';
import { stores } from '../../_oidc-provider/provider';
import { buildCibaLoginBindingCookie } from '../../_oidc-provider/features/ciba/cookies';
import { parseSessionId } from '../../_oidc-provider/cookies';
import { loginScreen, pendingRequestsScreen, remainingSeconds } from './screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 保留中の一覧か、ログインフォームを返す。
 *
 * `GET /ciba` の処理である。
 * `Cookie` ヘッダーが示す OP のセッションがストアにあれば、そのユーザー宛ての保留中のリクエストの一覧を返す。
 * セッションがなければ、ログイントランザクションを作ってストアに保存し、そのログインフォームを、このブラウザに結び付けるバインディング Cookie を付けて返す。
 *
 * 隠しフィールドの `csrf_token` だけでは、ログイン CSRF を防げない。
 * 攻撃者は自分で開いたフォームから、有効なトランザクション ID と `csrf_token` の組を手に入れられるためである。
 * そこで、フォームの送信にはこのブラウザのバインディング Cookie も求める（`_oidc-provider/features/ciba/cookies.ts` の `buildCibaLoginBindingCookie()` を参照）。
 */
export async function GET(request: Request): Promise<Response> {
  const sessionId = parseSessionId(request.headers.get('Cookie'));
  const session = sessionId ? await stores.browserSessionStore.get(sessionId) : undefined;
  if (session) {
    return pendingRequestsScreen(session.subject);
  }

  const { record, bindingSecret } = await createCibaLoginTransaction(cibaLoginTransactionStore);
  return loginScreen(
    { loginTransactionId: record.id, csrfToken: record.csrfToken },
    [buildCibaLoginBindingCookie(record.id, bindingSecret, remainingSeconds(record.expiresAt))],
  );
}
