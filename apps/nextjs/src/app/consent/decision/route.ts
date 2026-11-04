/**
 * Consent decision: the Route Handler the consent form of consent/page.tsx
 * posts to. It records the End-User's decision and answers with the
 * authorization response for the client (OIDC Core 1.0 §3.1.2.5 / §3.1.2.6).
 * A request of a response type a feature answers in place of the code alone
 * (the Implicit Flow, the Hybrid Flow) ends in that feature's block instead
 * of the code.
 *
 * A Route Handler, not a Server Action: the authorization response is a
 * redirect in the query and fragment response modes, but an HTML page in the
 * Form Post Response Mode (OAuth 2.0 Form Post Response Mode §2), and a
 * Server Action can only redirect.
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  AuthTransactionError,
  completeAuthTransaction,
  createAuthorizationCode,
  getAuthTransaction,
  validateCsrfToken,
} from '@maronn-openid-connect/core';
import {
  authorizationResponseOf,
  respondToClient,
  restoreResponseMode,
  type AuthorizationResponseMode,
  type ResponseModeTransaction,
} from '../../authorize/response-mode';
import { issueHybridConsentResponse } from '../../_oidc-provider/features/hybrid-flow/consent';
import { issueImplicitConsentResponse } from '../../_oidc-provider/features/implicit-flow/consent';
import { recordGrantedAuthorizationDetails } from '../../_oidc-provider/features/rar/consent';
import { readFormFields, redirectToErrorPage } from '../../_oidc-provider/http';
import { config, loadSigningKeys, resolvers, stores } from '../../_oidc-provider/provider';
import {
  buildClearedTransactionCookie,
  CROSS_ORIGIN_FORM_POST_MESSAGE,
  isSameOriginFormPost,
  parseTransactionId,
} from '../../_oidc-provider/cookies';
import { resolveGrantableScopes } from '../../_oidc-provider/scopes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 同意の決定を処理し、認可レスポンスで応答する。
 *
 * POST `/consent/decision` のルートハンドラである。
 * 承認なら認可コードを発行して同意とグラントを記録し、認可コードをクライアントへ返す。
 * 拒否なら `access_denied` を返す。
 * どちらも認可リクエストのレスポンスモードで返し、トランザクションの Cookie を消す。
 * `implicit-flow` と `hybrid-flow` の機能のレスポンスタイプには、認可コードだけを返す代わりに、その機能が応答する。
 *
 * フォームが別オリジンから送られたとき、トランザクションの Cookie がないとき、トランザクションが見つからないか期限切れのとき、`csrf_token` が一致しないとき、決定の値が `approve` でも `deny` でもないとき、レスポンスモードの鍵を読み込めないときは、ブラウザを OP のエラーページへリダイレクトする（303）。
 * ログインのステップが保存したサブジェクトがないまま承認されたときは、`/login` へリダイレクトする（303）。
 *
 * @spec OIDC Core 1.0 §3.1.2.4
 * @spec OIDC Core 1.0 §3.1.2.5
 * @spec OIDC Core 1.0 §3.1.2.6
 */
export async function POST(request: NextRequest): Promise<Response> {
  // [reject-cross-origin-post] 別オリジンからのフォーム POST を拒否する — OIDC Core 1.0 §3.1.2.4
  // 最初に、フォームの送信元を、ブラウザ自身が付けるヘッダーで確かめる（_oidc-provider/cookies.ts の `isSameOriginFormPost()`）。
  // この確認は、後で確かめる Cookie にも `csrf_token` にも依存しない。
  // このハンドラは認可コードを発行するので、OP 自身が表示したフォーム以外からの決定は受け付けない。
  const sameOrigin = isSameOriginFormPost(
    { origin: request.headers.get('Origin'), secFetchSite: request.headers.get('Sec-Fetch-Site') },
    config.issuer,
  );
  if (!sameOrigin) return redirectToErrorPage('cross_origin_request', CROSS_ORIGIN_FORM_POST_MESSAGE);

  // [load-transaction] Cookie が指すトランザクションを読み込む
  const form = await readFormFields(request);
  const action = String(form.get('action') ?? '');

  // トランザクションの Cookie から、このブラウザが進めているトランザクションを読み込む。
  // Cookie がない、トランザクションが見つからない（すでに終わったものを含む）、期限切れのときは、エンドユーザーがクライアントのアプリケーションからやり直す必要があるので、OP のエラーページへリダイレクトする。
  const transactionId = parseTransactionId(request.headers.get('Cookie'));
  const transaction = transactionId === undefined ? undefined : await findTransaction(transactionId);
  if (transactionId === undefined || transaction === undefined) {
    return redirectToErrorPage(
      'transaction_not_found',
      'This sign-in request was not found or has expired. Start again from the application.',
    );
  }

  // [validate-csrf-token] csrf_token をトランザクションと照合する
  // `csrf_token` が一致すれば、決定は、このトランザクションのためにこのブラウザへ表示したフォームから送られたと分かる。
  // このハンドラは認可コードを発行するので、決定を処理する前に確かめる。
  try {
    validateCsrfToken(transaction, String(form.get('csrf_token') ?? ''));
  } catch (error) {
    if (error instanceof AuthTransactionError) return redirectToErrorPage(error.code, error.message);
    throw error;
  }

  // [restore-response-mode] 認可リクエストのレスポンスモードを復元する — OAuth 2.0 Multiple Response Type Encoding Practices §2.1
  // 認可リクエストが求めたレスポンスモード（JARM の `query.jwt`、`form_post`、インプリシットフローのフラグメントなど）を、何かを記録する前に復元する。
  // こうしておけば、鍵を読み込めないときに、認可コードと同意を保存した後ではなく、ここで止まる。
  let responseMode: AuthorizationResponseMode | undefined;
  try {
    responseMode = await restoreResponseMode(transaction, { issuer: config.issuer, loadSigningKeys });
  } catch {
    return redirectToErrorPage('server_error', 'Failed to load the response signing key');
  }

  // [deny-authorization] 拒否: access_denied で応答する — OIDC Core 1.0 §3.1.2.6
  if (action === 'deny') {
    await stores.transactionStore.delete('auth_txn:' + transactionId);
    await stores.authSessionStore.delete(transactionId);
    // トランザクションは終わったので、それを指していた Cookie を消す。
    return respondToClient(
      await authorizationResponseOf(responseMode, transaction.redirectUri, {
        error: 'access_denied',
        state: transaction.state,
      }, config.issuer),
      [buildClearedTransactionCookie()],
    );
  }

  // [validate-decision] 明示的な承認を求める — OIDC Core 1.0 §3.1.2.4
  // 決定の値が `approve` でなければ、OP のエラーページへリダイレクトする。
  // 認可サーバーは、RP に情報を渡す前に認可の決定を得なければならない（MUST、OIDC Core 1.0 §3.1.2.4）。
  // このハンドラは認可コードを発行するので、承認は許可する値の一覧で判定し、`action` がない、空、未知の値のときは、決定を得られなかったものとして承認しない。
  // `approve` は、page.tsx の承認ボタンの値と揃えておく必要がある。
  //
  // `access_denied` はエンドユーザーがリクエストを拒否したことを表し、決定がないこととは違う（OIDC Core 1.0 §3.1.2.6）。
  // そのため、認識できない値はクライアントへ返さず、OP のエラーページへ送る。
  if (action !== 'approve') {
    return redirectToErrorPage(
      'invalid_request',
      'Invalid consent decision. Please use the Approve or Deny button.',
    );
  }

  // [require-authenticated-subject] ログイン済みのサブジェクトを取り出す
  // ログインのステップから引き渡された認証セッションを読む。
  // 認証したサブジェクトがなければ、ログインのステップが飛ばされたか期限が切れているので、`/login` へリダイレクトする。
  const session = await stores.authSessionStore.get(transactionId);
  if (!session) {
    return NextResponse.redirect(new URL('/login', config.issuer), 303);
  }

  // [issue-implicit-response] (feature: implicit-flow) インプリシットフロー: トークンを直接発行する — OIDC Core 1.0 §3.2.2.5
  const implicitResponse = await issueImplicitConsentResponse({ transactionId, transaction, session, responseMode });
  if (implicitResponse) return implicitResponse;

  // [issue-hybrid-response] (feature: hybrid-flow) ハイブリッドフロー: コードとトークンを発行する — OIDC Core 1.0 §3.3.2.5
  const hybridResponse = await issueHybridConsentResponse({ transactionId, transaction, session, responseMode });
  if (hybridResponse) return hybridResponse;

  // [issue-authorization-code] 認可コードを発行する — OIDC Core 1.0 §3.1.2.5 / §3.1.3.1
  const responseParams = await completeAuthTransaction(
    transactionId,
    transaction,
    stores.transactionStore,
  );

  // スコープの方針（エンドユーザーごとの絞り込みを書く scopes.ts の `resolveGrantableScopes()`）を適用する。
  // スコープを外しても、リクエストを失敗にはせず、許可するスコープを狭めるだけである。
  // 認可サーバーは要求より狭いスコープを発行してよく、許可したスコープはトークンレスポンスで伝わるためである（RFC 6749 §3.3）。
  const grantedScope = await resolveGrantableScopes(
    transaction.scope.split(' ').filter(Boolean),
    session.subject,
  );

  // 認可コードを発行してストアに保存する。
  // 有効期間は `ProviderConfig` の `authorizationCodeTtl` で設定でき、既定では 300 秒である（OIDC Core 1.0 §3.1.3.1）。
  const authCodeData = await createAuthorizationCode({
    authorizationResponse: { ...responseParams, scope: grantedScope },
    subject: session.subject,
    authTime: session.authTime,
    // `offline_access` のない認可で発行するリフレッシュトークンを、このログインセッション（ログインのステップが `authSessionStore` に載せた `sessionId`）に結び付ける。
    // ログアウトすると、そのリフレッシュトークンも使えなくなる。
    sessionId: session.sessionId,
    ttlSeconds: config.authorizationCodeTtl,
  });
  await stores.authCodeStore.set(authCodeData.code, authCodeData);

  // [record-granted-details] (feature: rar) 承認された authorization details をグラントへ紐付ける — RFC 9396 §7
  await recordGrantedAuthorizationDetails(transactionId, authCodeData.grantId, config.refreshTokenAbsoluteLifetime);

  // [record-consent] 同意とグラントを記録する — OIDC Core 1.0 §3.1.2.4
  // 同意を記録し、後の `prompt=none` や SSO のリクエストで、同意画面を出さずに同意を確かめられるようにする（OIDC Core 1.0 §3.1.2.1、§3.1.2.4）。
  // グラントも記録し、その同意を取り消したときに、グラントから発行したトークンを失効させられるようにする。
  // 削除するのはトランザクションごとの認証セッションだけで、OP のセッションは SSO のために残す。
  await resolvers.consentResolver.recordConsent?.(session.subject, transaction.clientId, grantedScope);
  await resolvers.consentResolver.recordGrant(session.subject, transaction.clientId, authCodeData.grantId);
  await stores.authSessionStore.delete(transactionId);

  // [build-authorization-response] 認可レスポンスを組み立てる — RFC 9207 §2
  // トランザクションは終わったので、それを指していた Cookie を消す。
  return respondToClient(
    await authorizationResponseOf(responseMode, transaction.redirectUri, {
      code: authCodeData.code,
      state: responseParams.state,
    }, config.issuer),
    [buildClearedTransactionCookie()],
  );
}

/**
 * ID でトランザクションをストアから読み込んで返す。
 *
 * トランザクションが見つからないとき（すでに終わったものを含む）と期限切れのときは `undefined` を返す。
 *
 * @throws ストアの読み込みで `AuthTransactionError` 以外のエラーが起きたときは、それをそのまま投げる。
 */
async function findTransaction(transactionId: string): Promise<ResponseModeTransaction | undefined> {
  try {
    return await getAuthTransaction(transactionId, stores.transactionStore);
  } catch (error) {
    if (error instanceof AuthTransactionError) return undefined;
    throw error;
  }
}
