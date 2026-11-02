import { createCibaLoginTransaction } from '@maronn-openid-connect/experimental/ciba';
import { buildCibaLoginBindingCookie } from '../../../cookies.js';
import { parseSessionId } from '../../../../../cookies.js';
import { type CibaOutcome, remainingSeconds, listPendingRequests } from '../outcome.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'prepare-device',
  endpoint: 'ciba',
  feature: 'ciba',
  kind: 'resolve',
  label: 'List pending requests, or start a login transaction',
  function: 'prepareCibaDevice',
  consumes: [],
  produces: ['loginTransaction'],
  removable: false,
});

/**
 * 保留中の一覧か、ログインフォームを出す結果を返す。
 *
 * `GET /ciba` の処理である。
 * `Cookie` ヘッダーが示す OP のセッションがストアにあれば、そのユーザー宛ての保留中のリクエストを `listPendingRequests()` で取得し、`pending_requests` の結果を返す。
 * セッションがなければ、ログイントランザクションを作ってストアに保存し、フォームに埋め込むトランザクション ID と CSRF トークン、バインディング Cookie を持つ `login` の結果を返す。
 * ログインフォームの送信（`POST /ciba/login`）には、このバインディング Cookie が必要である。
 */
export async function prepareCibaDevice(c: any): Promise<CibaOutcome> {
  const browserSessionStore = c.get('browserSessionStore');
  const loginTransactionStore = c.get('cibaLoginTransactionStore');

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (session) {
    return { kind: 'pending_requests', requests: await listPendingRequests(c, session.subject), cookies: [] };
  }

  const { record, bindingSecret } = await createCibaLoginTransaction(loginTransactionStore);
  const cookie = buildCibaLoginBindingCookie(
    record.id,
    bindingSecret,
    remainingSeconds(record.expiresAt),
  );
  return {
    kind: 'login',
    loginTransactionId: record.id,
    csrfToken: record.csrfToken,
    cookies: [cookie],
  };
}
