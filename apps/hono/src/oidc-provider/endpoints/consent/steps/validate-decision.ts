import type { ConsentOutcome } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'validate-decision',
  endpoint: 'consent',
  kind: 'validate',
  label: 'Require an explicit approve decision',
  spec: 'OIDC Core 1.0 §3.1.2.4',
  function: 'validateConsentDecision',
  consumes: ['action'],
  produces: [],
  removable: false,
});

/**
 * 承認でなければ `invalid_decision` を返す。
 *
 * `action` が `approve` のときだけ `undefined` を返す。
 * OIDC Core 1.0 §3.1.2.4 は、認可サーバーが RP に情報を渡す前に認可の決定を得ることを求めている（MUST）。
 * そのため承認は許可する値の一覧で判定し、`action` がない、空、未知の値のときは、決定を得られなかったものとして承認しない。
 * 「`deny` でなければ承認」と判定すると、想定していないすべての値で承認してしまう。
 *
 * `approve` はこの OP が受け付ける承認の値であり、views.tsx の `consentPage()` の承認ボタンの値と揃えておく必要がある。
 * 片方だけを変えると、すべての承認が、この結果に対して page.tsx が表示する 400 のエラーになる。
 *
 * `access_denied` はエンドユーザーがリクエストを拒否したことを表し、決定がないこととは違う（OIDC Core 1.0 §3.1.2.6）。
 * そのため、認識できない値はクライアントへリダイレクトせず、OP のエラーページで止める。
 *
 * @spec OIDC Core 1.0 §3.1.2.4
 * @spec OIDC Core 1.0 §3.1.2.6
 */
export function validateConsentDecision(action: string): ConsentOutcome | undefined {
  return action === 'approve' ? undefined : { kind: 'invalid_decision' };
}
