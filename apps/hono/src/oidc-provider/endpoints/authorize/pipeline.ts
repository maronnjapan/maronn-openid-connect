import { resolveFormPostResponseContext } from '../../features/form-post-response-mode/steps/resolve-form-post-response-mode.js';
import { validateHybridRequest } from '../../features/hybrid-flow/steps/validate-hybrid-request.js';
import { resolveFragmentResponseContext } from '../../features/implicit-flow/steps/resolve-fragment-response-mode.js';
import { validateImplicitRequest } from '../../features/implicit-flow/steps/validate-implicit-request.js';
import { resolveJarmResponseContext } from '../../features/jarm/steps/resolve-jarm-response-mode.js';
import { resolvePushedAuthorizationRequest } from '../../features/par/steps/resolve-pushed-request.js';
import { resolveRequestObject } from '../../features/request-object/steps/resolve-request-object.js';
import type { AuthorizationOutcome } from './outcome.js';
import type { AuthorizationResponseMode } from './response-mode.js';
import { completePromptNoneRequest } from './steps/authenticate-silently.js';
import { continueToLogin } from './steps/continue-to-login.js';
import { createAuthorizationTransaction } from './steps/create-transaction.js';
import { issueAuthorizationCodeResponse } from './steps/issue-authorization-code.js';
import { parseAuthorizationRequest } from './steps/parse-request.js';
import { resolveAuthorizationClient } from './steps/resolve-client.js';
import { resolveRedirectTarget } from './steps/resolve-redirect-uri.js';
import { authorizationErrorOutcome } from './steps/respond-error.js';
import { reuseExistingSession } from './steps/reuse-session.js';
import { rejectCombinedPromptNone } from './steps/validate-prompt-combination.js';
import { validateAuthorizationRequestParams } from './steps/validate-request.js';
import { verifyIdTokenHint } from './steps/verify-id-token-hint.js';

/**
 * ステップを順に実行し、認可リクエストの処理結果を返す。
 *
 * 各ブロックは一つのステップ（`maronn-oidc graph --detail steps --endpoint authorize` の箱一つ）を呼ぶ。
 * リクエストを解析し、クライアントと `redirect_uri` を特定し、パラメータを検証し、トランザクションを作り、`id_token_hint` を検証してから、`prompt=none` と SSO を試し、どちらにも当たらなければログイン画面へ移る。
 * 目印の行に機能の名前があるブロックはその機能のもので、そのステップは `features/<id>/` にある。
 *
 * 返す結果は、クライアントへの認可レスポンス、ログイン画面か同意画面へ移ること、OP で応答するエラーのどれかである。
 * この関数は `Response` を作らない。
 * `GET` と `POST` の `/authorize` を受ける `page.ts` が、結果を HTTP のレスポンスにする。
 * ステップが例外を投げると、`authorizationErrorOutcome()` がそれを結果に変える。
 *
 * @spec OIDC Core 1.0 §3.1.2
 */
export async function processAuthorizationRequest(c: any): Promise<AuthorizationOutcome> {
  // リクエストが求めたレスポンスモードのうち、機能が応答するもの（JARM、`form_post`、インプリシットフローとハイブリッドフローのフラグメント）を入れる。
  // `redirect_uri` を確かめた後、リクエストの `response_mode` か `response_type` に応答する機能のブロックのうち、最初のものが設定する（どのブロックも、まだ設定されていないときだけ代入する）。
  // `undefined` なら、パラメータをクエリに付ける通常の認可レスポンスで返す。
  // `catch` でもリクエストが求めたモードでエラーを返せるよう、`try` の前で宣言する。
  let responseMode: AuthorizationResponseMode | undefined;
  try {
    // 成功もエラーも、すべての認可レスポンスに付ける発行者の識別子を取り出す（RFC 9207 §2）。
    // クライアントは、この値でレスポンスを作った発行者を確かめられる。
    const issuer: string = c.get('config').issuer;

    // [parse-request] 認可リクエストを解析する — OIDC Core 1.0 §3.1.2.1 / §13.2
    const parsed = await parseAuthorizationRequest(c);
    if ('kind' in parsed) return parsed;
    let params = parsed.params;

    // [resolve-pushed-request] (feature: par) プッシュされた request_uri を展開する — RFC 9126 §4 / §5
    params = await resolvePushedAuthorizationRequest(c, params);

    // [resolve-client] クライアントを特定する — OAuth 2.1 §4.1.2.1 / RFC 8252 §8
    const client = await resolveAuthorizationClient(c, params);

    // [resolve-request-object] (feature: request-object) リクエストオブジェクトを検証し、その値で上書きする — OIDC Core 1.0 §6.1
    const { effectiveParams, requestObjectClaims } = await resolveRequestObject(c, params, client);

    // [resolve-redirect-uri] redirect_uri を確定し、エラーの返し先を決める — OIDC Core 1.0 §3.1.2.1 / RFC 6749 §4.1.2.1
    const { redirectUri, state } = resolveRedirectTarget(effectiveParams ?? params, client);

    // [resolve-jarm-response-mode] (feature: jarm) response_mode=query.jwt を解釈する — JARM §2.3 / §3
    responseMode ??= resolveJarmResponseContext(c, effectiveParams ?? params, client, redirectUri, state, issuer);

    // [resolve-form-post-response-mode] (feature: form-post-response-mode) response_mode=form_post を解釈する — OAuth 2.0 Form Post Response Mode §2
    responseMode ??= resolveFormPostResponseContext(effectiveParams ?? params, issuer);

    // [resolve-fragment-response-mode] (feature: implicit-flow) インプリシットフローをフラグメントで返す — OAuth 2.0 Multiple Response Type Encoding Practices §2.1 / §3 / §5
    responseMode ??= resolveFragmentResponseContext(effectiveParams ?? params, issuer);

    // [validate-request] リクエストのパラメータを検証する — OIDC Core 1.0 §3.1.2.1-§3.1.2.2 / OAuth 2.1 §4.1.1 / §7.5
    const validatedRequest = await validateAuthorizationRequestParams(c, { params, effectiveParams, requestObjectClaims, client, redirectUri, state });

    // [validate-implicit-request] (feature: implicit-flow) インプリシットフローのリクエストを検証する — OIDC Core 1.0 §3.2.2.1 / OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5
    validateImplicitRequest(validatedRequest, effectiveParams ?? params, client, responseMode);

    // [validate-hybrid-request] (feature: hybrid-flow) ハイブリッドフローのリクエストを検証する — OIDC Core 1.0 §3.3.2.1 / §3.3.2.11 / OAuth 2.0 Multiple Response Type Encoding Practices §5
    validateHybridRequest(validatedRequest, effectiveParams ?? params, responseMode);

    // [create-transaction] 認可トランザクションを作って保存する — OIDC Core 1.0 §3.1.2.3
    const { transactionId, transaction, transactionTtlSeconds } = await createAuthorizationTransaction(c, validatedRequest, responseMode);

    // [validate-prompt-combination] ほかの値と併用された prompt=none を拒否する — OIDC Core 1.0 §3.1.2.1
    // `prompt` は空白で区切った値の並びなので、空白で分けて配列にする（OIDC Core 1.0 §3.1.2.1）。
    const promptValues = transaction.prompt?.trim().split(/\s+/).filter(Boolean) ?? [];
    const promptCombinationError = await rejectCombinedPromptNone(c, promptValues, transactionId, transaction, issuer, responseMode);
    if (promptCombinationError) return promptCombinationError;

    // [verify-id-token-hint] id_token_hint を検証する — OIDC Core 1.0 §3.1.2.1
    const hint = await verifyIdTokenHint(c, transactionId, transaction, issuer, responseMode);
    if ('kind' in hint) return hint;
    const { verifiedHintSubject } = hint;

    // [authenticate-silently] prompt=none: 画面を出さずに認証する — OIDC Core 1.0 §3.1.2.1
    const silent = await completePromptNoneRequest(c, { promptValues, transactionId, transaction, verifiedHintSubject, issuer, responseMode });
    if (silent !== undefined) {
      if ('kind' in silent) return silent;
      return issueAuthorizationCodeResponse(c, { transactionId, transaction, session: silent.session, issuer, responseMode });
    }

    // [reuse-session] SSO: 有効な OP のセッションを再利用する — OIDC Core 1.0 §3.1.2.3
    const sso = await reuseExistingSession(c, { promptValues, transactionId, transaction, transactionTtlSeconds, verifiedHintSubject });
    if (sso !== undefined) {
      if ('kind' in sso) return sso;
      return issueAuthorizationCodeResponse(c, { transactionId, transaction, session: sso.session, issuer, responseMode });
    }

    // [continue-to-login] ログイン画面へ進む — OIDC Core 1.0 §3.1.2.3
    return continueToLogin(transactionId, transactionTtlSeconds);
  } catch (error) {
    return authorizationErrorOutcome(c, error, responseMode);
  }
}
