import { issueHybridConsentResponse } from '../../features/hybrid-flow/steps/issue-hybrid-response.js';
import { issueImplicitConsentResponse } from '../../features/implicit-flow/steps/issue-implicit-response.js';
import type { ConsentError, ConsentOutcome, ConsentScreen, ConsentSubmission } from './screen.js';
import { buildConsentRedirect } from './steps/build-authorization-response.js';
import { denyAuthorizationRequest } from './steps/deny-authorization.js';
import { describeConsentScreen } from './steps/describe-consent-screen.js';
import { issueConsentedAuthorizationCode } from './steps/issue-authorization-code.js';
import { loadTransaction } from './steps/load-transaction.js';
import { recordConsentDecision } from './steps/record-consent.js';
import { rejectCrossOriginFormPost } from './steps/reject-cross-origin-post.js';
import { requireAuthenticatedSubject } from './steps/require-authenticated-subject.js';
import { validateConsentCsrfToken } from './steps/validate-csrf-token.js';
import { validateConsentDecision } from './steps/validate-decision.js';

/**
 * Consent step (API layer: logic only).
 *
 * Everything the consent screen has to decide is a step (steps/), one box of
 * `maronn-oidc graph --detail steps --endpoint consent`: finding the
 * transaction through the transaction cookie (loadTransaction), the
 * csrf_token check (validateConsentCsrfToken), the scope policy and the form
 * (describeConsentScreen), the authorization decision
 * (validateConsentDecision, denyAuthorizationRequest), the authorization code
 * (issueConsentedAuthorizationCode), the consent record
 * (recordConsentDecision) and the authorization response
 * (buildConsentRedirect: RFC 6749 §4.1.2 / RFC 9207 iss, or the response mode
 * of a feature). A request of a response type a feature answers in place of
 * the code alone (the Implicit Flow, the Hybrid Flow) ends in that feature's
 * block instead of the code. None of them builds a Response — each returns an outcome,
 * and page.tsx turns that outcome into a screen or a redirect.
 * prepareConsent() (GET) and submitConsent() (POST) run them in the order the
 * screen needs, so the UI can be changed without touching this file.
 */

/**
 * トランザクションを読み込み、同意画面の内容を返す。
 *
 * GET `/consent` のハンドラ（page.tsx）が呼ぶ。
 * トランザクションは、ブラウザの Cookie が指すものを読み込む。
 * 同意画面の内容は、`csrf_token`、クライアント ID、エンドユーザーに許可を求めるスコープである。
 * トランザクションを読み込めないときは、代わりに表示するエラー（`kind: 'error'`）を返す。
 */
export async function prepareConsent(c: any): Promise<ConsentScreen | ConsentError> {
  // [load-transaction] Cookie が指すトランザクションを読み込む
  const loaded = await loadTransaction(c);
  if ('kind' in loaded) return loaded;
  const { transactionId, transaction } = loaded;
  // [describe-consent-screen] 同意画面の表示内容を組み立てる
  return describeConsentScreen(c, transactionId, transaction);
}

/**
 * 同意の決定を処理し、認可レスポンスかエラーを返す。
 *
 * POST `/consent` のハンドラ（page.tsx）が呼ぶ。
 * 承認なら、認可コード（インプリシットフローとハイブリッドフローでは ID トークンやアクセストークン）を発行して同意を記録し、認可レスポンス（`kind: 'authorization_response'`）を返す。
 * 拒否なら、`access_denied` の認可レスポンスを返す。
 * フォームが別オリジンから送られたとき、トランザクションが見つからないとき、`csrf_token` が一致しないときは、エラー（`kind: 'error'`）を返す。
 * 決定の値が `approve` でも `deny` でもなければ `invalid_decision` を、ログインのステップが保存したサブジェクトがなければ `session_missing` を返す。
 *
 * ステップの順は画面に合わせて固定してある（`maronn-oidc graph --detail steps --endpoint consent` で確かめられる）。
 */
export async function submitConsent(c: any, input: ConsentSubmission): Promise<ConsentOutcome> {
  const { csrfToken, action } = input;

  // 決定を処理する前に、送信元、トランザクションの Cookie、`csrf_token` を確かめる。
  // この処理は認可コードを発行するので、承認も拒否も、OP 自身が表示したフォーム以外からは受け付けない。
  // [reject-cross-origin-post] 別オリジンからのフォーム POST を拒否する
  // 最初に、フォームの送信元を、ブラウザ自身が付けるヘッダーで確かめる（cookies.ts の `isSameOriginFormPost()`）。
  // この確認は Cookie にも `csrf_token` にも依存しないので、両方を仕込まれていても偽造された POST を止められる。
  const sameOriginError = rejectCrossOriginFormPost(c);
  if (sameOriginError) return sameOriginError;

  // [load-transaction] Cookie が指すトランザクションを読み込む
  const loaded = await loadTransaction(c);
  if ('kind' in loaded) return loaded;
  const { transactionId, transaction } = loaded;

  // [validate-csrf-token] csrf_token をトランザクションと照合する
  // 一致すれば、決定はこのトランザクションのために OP が描画したフォームから送られたと分かる。
  const csrfError = validateConsentCsrfToken(transaction, csrfToken);
  if (csrfError) return csrfError;

  // 成功とエラーのどちらの認可レスポンスにも含める発行者の識別子を、設定から読む（RFC 9207 §2）。
  // クライアントは、レスポンスを返した発行者が想定どおりかを確かめられる。
  const issuer: string = c.get('config').issuer;

  // [deny-authorization] 拒否: access_denied で応答する — OIDC Core 1.0 §3.1.2.6
  if (action === 'deny') {
    return denyAuthorizationRequest(c, transactionId, transaction, issuer);
  }

  // [validate-decision] 明示的な承認を求める — OIDC Core 1.0 §3.1.2.4
  const decisionError = validateConsentDecision(action);
  if (decisionError) return decisionError;

  // [require-authenticated-subject] ログイン済みのサブジェクトを取り出す
  const session = await requireAuthenticatedSubject(c, transactionId);
  if (!session) {
    return { kind: 'session_missing' };
  }

  // [issue-implicit-response] (feature: implicit-flow) インプリシットフロー: トークンを直接発行する — OIDC Core 1.0 §3.2.2.5
  const implicitResponse = await issueImplicitConsentResponse(c, { transactionId, transaction, session, issuer });
  if (implicitResponse) return implicitResponse;

  // [issue-hybrid-response] (feature: hybrid-flow) ハイブリッドフロー: コードとトークンを発行する — OIDC Core 1.0 §3.3.2.5
  const hybridResponse = await issueHybridConsentResponse(c, { transactionId, transaction, session, issuer });
  if (hybridResponse) return hybridResponse;

  // [issue-authorization-code] 認可コードを発行する — OIDC Core 1.0 §3.1.2.5
  const { responseParams, authCodeData, grantedScope } = await issueConsentedAuthorizationCode(
    c,
    transactionId,
    transaction,
    session,
  );

  // [record-consent] 同意とグラントを記録する — OIDC Core 1.0 §3.1.2.4
  await recordConsentDecision(c, transactionId, transaction, session, authCodeData, grantedScope);

  // [build-authorization-response] 認可レスポンスを組み立てる
  return buildConsentRedirect(c, transaction, responseParams.redirectUri, {
    code: authCodeData.code,
    state: responseParams.state,
  }, issuer);
}
