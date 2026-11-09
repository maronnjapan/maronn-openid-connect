import {
  type AuthTransaction,
  requiresReauthentication,
  type SessionInfo,
} from '@maronn-openid-connect/core';
import { buildTransactionCookie } from '../../../cookies.js';
import { resolveGrantableScopes } from '../../../scopes.js';
import type { AuthorizationOutcome } from '../outcome.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'reuse-session',
  endpoint: 'authorize',
  kind: 'dispatch',
  label: 'SSO: 有効な OP のセッションを再利用する',
  spec: 'OIDC Core 1.0 §3.1.2.3',
  function: 'reuseExistingSession',
  calls: ['consentResolver.hasConsent'],
  consumes: ['promptValues', 'transactionId', 'transaction', 'transactionTtlSeconds', 'verifiedHintSubject'],
  produces: ['session'],
  removable: true,
});

/**
 * 有効なセッションを再利用し、同意済みならそれを返す。
 *
 * ログイン画面を出さずに、OP の有効なセッションを再利用する（SSO）。
 * 次のどれかに当たるときは再利用せず、`undefined` を返す（パイプラインはログイン画面へ進む）。
 * - `prompt` に `login` か `select_account` がある（必ず認証し直させる）。
 * - セッションリゾルバが無い、または有効なセッションが無い。
 * - `max_age` があり、セッションの認証時刻がそれより古い（OIDC Core 1.0 §3.1.2.1）。
 * - セッションのエンドユーザーが `id_token_hint` の指すエンドユーザーと違う（OIDC Core 1.0 §3.1.2.1）。
 *
 * 再利用するときは、要求されたスコープを、このエンドユーザーに許すスコープだけに絞る。
 * `prompt=consent` でなく、エンドユーザーが絞った後のスコープにこのクライアントへすでに同意していれば、セッションを返す（パイプラインは認可コードを発行する）。
 * そうでなければ、認証済みのサブジェクトを `authSessionStore` に保存し、トランザクションの Cookie を付けて同意画面へ移る結果を返す。
 * `prompt=consent` のときは、同意済みでも同意画面へ移り、同意をもう一度求める（OIDC Core 1.0 §3.1.2.1）。
 *
 * @spec OIDC Core 1.0 §3.1.2.3
 */
export async function reuseExistingSession(
  c: any,
  input: {
    promptValues: string[];
    transactionId: string;
    transaction: AuthTransaction;
    transactionTtlSeconds: number;
    verifiedHintSubject: string | undefined;
  },
): Promise<{ session: SessionInfo } | AuthorizationOutcome | undefined> {
  const { promptValues, transactionId, transaction, transactionTtlSeconds, verifiedHintSubject } = input;
  if (promptValues.includes('login') || promptValues.includes('select_account')) return undefined;
  const sessionResolver = c.get('sessionResolver');
  if (!sessionResolver) return undefined;

  const existingSession = await sessionResolver.resolve(c.req.raw);
  const sessionIsFresh =
    existingSession !== null &&
    (transaction.maxAge === undefined ||
      !requiresReauthentication(transaction.maxAge, existingSession.authTime));
  // セッションのエンドユーザーが `id_token_hint` の指すエンドユーザーでなければ、セッションを再利用しない（OIDC Core 1.0 §3.1.2.1）。
  // この確認が無いと、セッションがユーザー B で `id_token_hint` がユーザー A のリクエストに、B の認可コードを黙って発行してしまう。
  // 一致しないときはエラーにせずログイン画面へ進め、正しいエンドユーザーとして認証させる（すぐに `login_required` を返すかどうかは、OP の方針で決める）。
  const hintMatchesSession =
    verifiedHintSubject === undefined ||
    (existingSession !== null && verifiedHintSubject === existingSession.subject);
  if (!existingSession || !sessionIsFresh || !hintMatchesSession) return undefined;

  // `prompt=consent` なら、同意画面を必ず表示し直す（OIDC Core 1.0 §3.1.2.1）。
  // そうでなく、ユーザーが要求されたスコープ（またはそれを含むスコープ）にこのクライアントへすでに同意していれば、同意画面を飛ばして認可コードを発行する。
  const consentResolver = c.get('consentResolver');

  // 下の同意の照会より前に、スコープのポリシーで `transaction.scope` を、このエンドユーザーに許すスコープだけに絞る。
  // 得られないスコープを含めたまま照会すると、同意済みと判定されないためである（`prompt=none` のときと同じ理由）。
  // 絞った値はストアに書き戻さず、この処理の中でだけ使う。
  // 同意画面へ移るときは、`/consent` が `authSessionStore` から読んだ認証済みのサブジェクトで、ポリシーをもう一度適用する。
  transaction.scope = (await resolveGrantableScopes(
    transaction.scope.split(' ').filter(Boolean),
    existingSession.subject,
  )).join(' ');
  const requestedScopes = transaction.scope.split(' ').filter(Boolean);
  const consentAlreadyGranted =
    !promptValues.includes('consent') &&
    consentResolver !== undefined &&
    (await consentResolver.hasConsent(
      existingSession.subject,
      transaction.clientId,
      requestedScopes,
    ));
  if (consentAlreadyGranted) {
    return { session: existingSession };
  }

  const authSessionStore = c.get('authSessionStore');
  await authSessionStore.set(transactionId, {
    subject: existingSession.subject,
    authTime: existingSession.authTime,
    // 同意画面を経由しても、オンラインのリフレッシュトークンを結び付けるセッションが分かるよう、同意画面へ渡す値にセッション ID も入れる。
    sessionId: existingSession.sessionId,
  });
  // 同意画面（`endpoints/consent/page.tsx`）へ移る結果を返す。
  // 同意画面は、リダイレクトに付けるトランザクションの Cookie からトランザクションを見つける。
  return {
    kind: 'consent',
    transactionId,
    cookies: [buildTransactionCookie(transactionId, transactionTtlSeconds)],
  };
}
