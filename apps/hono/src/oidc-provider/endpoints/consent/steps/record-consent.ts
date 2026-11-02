import type { AuthTransaction, AuthorizationCodeData } from '@maronn-openid-connect/core';
import type { AuthSessionInfo } from '../../../store.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'record-consent',
  endpoint: 'consent',
  kind: 'persist',
  label: 'Record the consent and the grant',
  spec: 'OIDC Core 1.0 §3.1.2.4',
  function: 'recordConsentDecision',
  calls: ['consentResolver.recordConsent', 'consentResolver.recordGrant'],
  consumes: ['transactionId', 'transaction', 'session', 'authCodeData', 'grantedScope'],
  produces: [],
  removable: false,
});

/**
 * 同意とグラントを記録し、認証セッションを削除する。
 *
 * 同意を記録しておくと、後の `prompt=none` のリクエストや画面を出さない SSO のリクエストで、画面を出さずに同意を確かめられる。
 * グラントを同意に記録しておくと、その同意を取り消したときに、グラントから発行したトークンも失効させられる。
 * 記録は `consentResolver` の `recordConsent()` と `recordGrant()` を通して行うので、保存先を独自のストアに差し替えられる。
 * どちらのメソッドも、リゾルバにないときは呼ばない。
 *
 * 削除するのは、ログインのステップから引き渡された認証セッションだけである。
 * ブラウザの OP のセッションは残すので、SSO は引き続き使える。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 * @spec OIDC Core 1.0 §3.1.2.4
 */
export async function recordConsentDecision(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
  session: AuthSessionInfo,
  // The grant of the code — or of the tokens the Implicit Flow returns in its place.
  grant: Pick<AuthorizationCodeData, 'grantId'>,
  grantedScope: string[],
): Promise<void> {
  const authSessionStore = c.get('authSessionStore');
  const consentResolver = c.get('consentResolver');
  await consentResolver.recordConsent?.(session.subject, transaction.clientId, grantedScope);
  await consentResolver.recordGrant?.(
    session.subject,
    transaction.clientId,
    grant.grantId,
  );
  await authSessionStore.delete(transactionId);
}
