import { buildTransactionCookie } from '../../../cookies.js';
import type { AuthorizationOutcome } from '../outcome.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'continue-to-login',
  endpoint: 'authorize',
  kind: 'respond',
  label: 'ログイン画面へ進む',
  spec: 'OIDC Core 1.0 §3.1.2.3',
  function: 'continueToLogin',
  consumes: ['transactionId', 'transactionTtlSeconds'],
  produces: [],
  removable: false,
});

/**
 * ログイン画面へ移る結果を返す。
 *
 * 結果には、トランザクション ID を入れたトランザクションの Cookie を付ける。
 * ログイン画面（`endpoints/login/page.tsx`）は、リダイレクトに付いたこの Cookie からトランザクションを見つけ、エンドユーザーを対話で認証する。
 * `prompt=login` のリクエストは、セッションがあってもここへ来て、ログイン画面で認証し直す。
 *
 * @spec OIDC Core 1.0 §3.1.2.3
 */
export function continueToLogin(transactionId: string, transactionTtlSeconds: number): AuthorizationOutcome {
  return { kind: 'login', cookies: [buildTransactionCookie(transactionId, transactionTtlSeconds)] };
}
