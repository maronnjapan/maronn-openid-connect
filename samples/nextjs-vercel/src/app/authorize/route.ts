/**
 * Authorization Endpoint (OIDC Core 1.0 §3.1.2).
 *
 * The browser's entry into the flow, so every answer is a redirect or a page:
 * back to the client with the authorization response (a redirect, or the form
 * a form_post response is posted from), on to the login or consent screen,
 * or — for an error that must not go back to the client — to the OP's own
 * error page (app/oidc-error).
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  resolveClientForAuthorization,
  validateRegisteredRedirectUris,
  validateRequestObjectConsistency,
  resolveAuthorizationRedirectUri,
  rejectUnsupportedRequestParams,
  validateResponseType,
  validateAuthorizationScope,
  validateOpenIdScopeForResponseType,
  validateClientScope,
  validateAuthorizationCodePkce,
  validatePromptParameter,
  applyOfflineAccessPolicy,
  validateDisplayParameter,
  resolveMaxAge,
  parseAudienceParameter,
  parseClaimsRequestParameter,
  validateAcrValuesParameter,
  validateIdTokenHint,
  createAuthTransaction,
  buildTransactionPath,
  createAuthorizationCode,
  completeAuthTransaction,
  generateRandomString,
  resolvePromptNoneSession,
  validatePromptNoneIdTokenHint,
  validatePromptNoneConsent,
  requiresReauthentication,
  sanitizeErrorDescription,
  AuthorizationError,
  AuthorizationErrorCode,
  IdTokenHintError,
  responseTypeIncludes,
  type AuthorizationRequestParams,
  type AuthTransaction,
  type SessionInfo,
} from '@maronn-openid-connect/core';
import { resolveFormPostResponseContext } from '../_oidc-provider/features/form-post-response-mode/authorize';
import { issueHybridResponse, validateHybridRequest } from '../_oidc-provider/features/hybrid-flow/authorize';
import {
  issueImplicitResponse,
  resolveFragmentResponseContext,
  validateImplicitRequest,
} from '../_oidc-provider/features/implicit-flow/authorize';
import { fetchRequestUri, resolveRequestObject } from '../_oidc-provider/features/request-object/authorize';
import { responseTypesOf, tokenGrantsOf } from '../_oidc-provider/feature';
import { features } from '../_oidc-provider/features';
import {
  clientResolver,
  config,
  idTokenHintJwks,
  loadSigningKeys,
  resolvers,
  stores,
} from '../_oidc-provider/provider';
import {
  isFormUrlEncoded,
  redirectToErrorPage,
  signingKeysUnavailable,
  uniqueParams,
  type UniqueParams,
} from '../_oidc-provider/http';
import { buildTransactionCookie } from '../_oidc-provider/cookies';
import { findUnsupportedScopes, resolveGrantableScopes } from '../_oidc-provider/scopes';
import {
  authorizationResponseOf,
  respondToClient,
  type AuthorizationResponseMode,
  type ResponseModeTransaction,
} from './response-mode';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const { transactionStore, authCodeStore, authSessionStore } = stores;
const { sessionResolver, consentResolver } = resolvers;

/**
 * クエリから読んだパラメータで認可リクエストに応答する。
 *
 * 認可エンドポイントは `GET` に対応する必要がある（OIDC Core 1.0 §3.1.2.1）。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 */
export async function GET(request: NextRequest): Promise<Response> {
  return authorize(request, uniqueParams(request.nextUrl.searchParams));
}

/**
 * ボディから読んだパラメータで認可リクエストに応答する。
 *
 * 認可エンドポイントは `POST` にも対応し、ボディを `application/x-www-form-urlencoded` で受け取る（OIDC Core 1.0 §3.1.2.1、§13.2）。
 * `Content-Type` が `application/x-www-form-urlencoded` でなければ、400 の JSON で `invalid_request` を返す。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 * @spec OIDC Core 1.0 §13.2
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!isFormUrlEncoded(request)) {
    return badRequest('Authorization POST requests must use application/x-www-form-urlencoded');
  }
  return authorize(request, uniqueParams(new URLSearchParams(await request.text())));
}

/**
 * ステップを順に実行し、認可リクエストに応答する。
 *
 * リクエストを検証してトランザクションとして保存し、画面が要らなければ（`prompt=none`、または以前に同意したエンドユーザーの SSO）、すぐに認可レスポンスでクライアントに応答する。
 * 画面が要るときは、トランザクションの Cookie を付けて、`/login` か `/consent` へ 302 でリダイレクトする。
 *
 * `redirect_uri` を確かめた後に見つけたエラーは、リクエストが求めたレスポンスモードで、`state` と `iss` を付けてクライアントへ返す。
 * 確かめる前に見つけたエラー（未知の `client_id`、登録されていない `redirect_uri`）では、ブラウザを OP のエラー画面へ 303 でリダイレクトし、`application/json` を受け付ける呼び出し元には 400 の JSON で応答する。
 * パラメータの重複と `client_id` の欠落には 400 の JSON で、署名鍵を読み込めなければ 503 で、それ以外の例外には 500 の `server_error` で応答する。
 *
 * @spec OIDC Core 1.0 §3.1.2
 */
async function authorize(request: NextRequest, parsed: UniqueParams): Promise<Response> {
  // [load-signing-keys] 署名鍵を読み込む — OIDC Core 1.0 §10.1
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

  // [parse-request] 認可リクエストを解析する — OIDC Core 1.0 §3.1.2.1 / RFC 6749 §3.1
  // 同じパラメータが繰り返されていれば、400 の JSON で `invalid_request` を返す（OIDC Core 1.0 §3.1.2.1、RFC 6749 §3.1）。
  if (parsed.duplicateKey !== undefined) {
    return badRequest(`Parameter "${parsed.duplicateKey}" must not be repeated`);
  }
  if (!isAuthorizationRequestParams(parsed.params)) {
    return badRequest('Missing required parameter: client_id');
  }
  let params: Record<string, string> & AuthorizationRequestParams = parsed.params;

  // リクエストが求めたレスポンスモードのうち、機能が応答するもの（JARM、`form_post`、インプリシットフローとハイブリッドフローのフラグメント）を入れる。
  // `redirect_uri` を確かめた後、リクエストの `response_mode` か `response_type` に応答する機能のブロックのうち、最初のものが設定する（どのブロックも、まだ設定されていないときだけ代入する）。
  // `undefined` なら、パラメータをクエリに付ける通常の認可レスポンスで返す。
  // `catch` でもリクエストが求めたモードでエラーを返せるよう、`try` の前で宣言する。
  let responseMode: AuthorizationResponseMode | undefined;
  // 成功もエラーも、すべての認可レスポンスに付ける発行者の識別子を取り出す（RFC 9207 §2）。
  // クライアントは、この値でレスポンスを作った発行者を確かめられる。
  const issuer = config.issuer;

  // 下の各ステップは独立した関数で、OIDC Core 1.0 §3.1.2 の順に呼ぶ。
  // 検証を一つ外すにはその呼び出しを消し、独自の処理を足すにはステップの間に差し込む。
  // `redirectUri` を特定する前のステップはリダイレクトできないエラー（OP で表示する）を投げ、後のステップはリダイレクトできるエラー（クライアントへ返す）を投げる。
  try {
    // [resolve-client] クライアントを特定する — OAuth 2.1 §4.1.2.1 / RFC 8252 §8
    const client = await resolveClientForAuthorization(params, clientResolver);
    // 登録済みのリダイレクト URI に設定の誤り（フラグメント、`javascript:` などの危険なスキーム、ループバック以外の `http`）があれば、この時点で `server_error` を投げる（OIDC Core 1.0 §3.1.2.1、RFC 8252 §8）。
    validateRegisteredRedirectUris(client.redirectUris);

    // [fetch-request-uri] (feature: request-object) request_uri からリクエストオブジェクトを取得する — OIDC Core 1.0 §6.2
    params = await fetchRequestUri(params, client);

    // [resolve-request-object] (feature: request-object) リクエストオブジェクトを検証し、その値で上書きする — OIDC Core 1.0 §6.1
    const { effectiveParams, requestObjectClaims } = await resolveRequestObject(params, client);

    // [resolve-redirect-uri] redirect_uri を確定し、エラーの返し先を決める — OIDC Core 1.0 §3.1.2.1 / RFC 6749 §4.1.2.1
    // 後のステップが検証するパラメータを決める。
    // リクエストオブジェクトがあればそのクレームでクエリを上書きしたもの、無ければクエリのままである。
    const requestParams = effectiveParams ?? params;
    const redirectUri = resolveAuthorizationRedirectUri(requestParams, client);
    // ここから後のリダイレクトできるエラーには、この `state` をそのまま付けて返す（RFC 6749 §4.1.2.1）。
    const state = requestParams.state;

    // [resolve-form-post-response-mode] (feature: form-post-response-mode) response_mode=form_post を解釈する — OAuth 2.0 Form Post Response Mode §2
    responseMode ??= resolveFormPostResponseContext(requestParams, issuer);

    // [resolve-fragment-response-mode] (feature: implicit-flow) インプリシットフローをフラグメントで返す — OAuth 2.0 Multiple Response Type Encoding Practices §2.1 / §3 / §5
    responseMode ??= resolveFragmentResponseContext(requestParams, issuer);

    // [validate-request] リクエストのパラメータを検証する — OIDC Core 1.0 §3.1.2.1-§3.1.2.2 / OAuth 2.1 §4.1.1 / §7.5
    // `registration` には対応していないので拒否する（OIDC Core 1.0 §6.3）。
    // `request` は、上でリクエストオブジェクトを処理したとき（`effectiveParams` があるとき）だけ通し、それ以外は拒否する。
    // `request_uri` は、request-object の機能の `fetch-request-uri` のブロックが取得して `request` に置き換えるので、ここに残っているのは取得しなかったものであり、`request_uri_not_supported` で拒否する。
    rejectUnsupportedRequestParams(params, redirectUri, state, {
      requestParameterSupported: effectiveParams !== undefined,
    });

    // リクエストオブジェクトの中の `response_type` と `client_id` が、OAuth のクエリパラメータと一致することを確かめる（OIDC Core 1.0 §6.1）。
    validateRequestObjectConsistency(params, requestObjectClaims, redirectUri, state);

    // `response_type` が、OP の応答するレスポンスタイプのどれかで、しかもクライアントに登録されていることを確かめる。
    // OP が応答するのは、`code` と、機能が応答するレスポンスタイプ（各機能の `feature.ts` の `authorize.responseTypes`）である。
    const responseType = validateResponseType(params, client, redirectUri, state, [
      'code',
      ...responseTypesOf(features),
    ]);

    // `scope` がクエリにある（OIDC Core 1.0 §6.1）ことを確かめ、スコープを取り出す。
    // 設定の `requireOpenIdScope` が `true` なら、`openid` を含まないリクエストを `invalid_scope` で拒否する（同 §3.1.2.1）。
    // `false`（既定）なら、`openid` のないリクエストを OAuth 2.0 の認可リクエストとして受け付ける（同 §3.1.2.2）。
    // そのリクエストから発行するトークンは `openid` を持たないので、ID トークンは発行されず、UserInfo エンドポイントも使えない。
    let scope = validateAuthorizationScope(params, requestParams, redirectUri, state, {
      requireOpenIdScope: config.requireOpenIdScope,
    });

    // `code` 以外の `response_type`（インプリシットフローとハイブリッドフロー）は OpenID Connect のフローなので、設定によらず `openid` を求める（OIDC Core 1.0 §3.2.2.1、§3.3.2.1）。
    // これらのフローは認可エンドポイントで ID トークンを発行するので、`openid` のないリクエストには応答できない。
    validateOpenIdScopeForResponseType(responseType, scope, redirectUri, state);

    // スコープの一覧（`client.scope`）を登録したクライアントは、その一覧のスコープしか要求できない（RFC 7591 §2）。
    // 一覧に無いスコープは、`offline_access` も含めて `invalid_scope` で拒否する。
    validateClientScope(scope, client.scope, redirectUri, state);

    // `S256` の PKCE を検証する（OAuth 2.1 §4.1.1 / §7.5）。
    // `allowNonPkceAuthorizationCodeFlow` は、OIDF の適合性テスト（`Basic OP` の静的クライアント）との互換のためだけにあり、コンフィデンシャルクライアントが PKCE のパラメータをすべて省いたときだけ PKCE なしを許す。
    // PKCE は認可コードに結び付けるものなので、認可コードを返さないレスポンスタイプ（インプリシットフロー、OIDC Core 1.0 §3.2）では検証しない。
    const pkce = responseTypeIncludes(responseType, 'code')
      ? validateAuthorizationCodePkce(requestParams, client, redirectUri, state, {
        allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow,
      })
      : { codeChallenge: undefined, codeChallengeMethod: undefined };

    // `prompt` の各値が `none`、`login`、`consent`、`select_account` のどれかであることを確かめる（OIDC Core 1.0 §3.1.2.1）。
    // `none` とほかの値の併用も、`invalid_request` で拒否する。
    const prompt = validatePromptParameter(requestParams, redirectUri, state);

    // `offline_access` は、次の二つの条件を両方満たしたときだけスコープに残す。
    // - エンドユーザーが同意する（`prompt=consent`、OIDC Core 1.0 §11）。
    // - クライアント登録の `grant_types` に `refresh_token` がある（既定は `["authorization_code"]`、RFC 7591 §2）。
    // 二つ目の条件が無いと、発行したリフレッシュトークンは `unauthorized_client` で拒否されるだけの、使えない認証情報になる。
    // どちらの条件も、この OP が `refresh_token` のグラントを受け付ける（`refresh-token` の機能がある）ときに限る。
    // 受け付けないなら、コールバックが常に `false` を返し、`offline_access` を常に無視する（OIDC Core 1.0 §11）。
    // 認可コードを返さない `response_type`（インプリシットフロー）の `offline_access` は、`applyOfflineAccessPolicy()` がコールバックによらず無視する（同 §11）。
    // 独自の許可条件を使うなら、コールバックを渡す（コールバックは `client` も受け取る）:
    //   `scope = await applyOfflineAccessPolicy(scope, requestParams, prompt, client,`
    //   `  (req, { promptValues }) => promptValues.includes('consent') || hasStoredConsent(req));`
    const refreshTokensOffered = tokenGrantsOf(features).includes('refresh_token');
    scope = await applyOfflineAccessPolicy(
      scope,
      requestParams,
      prompt,
      client,
      refreshTokensOffered ? undefined : () => false,
    );

    // 独自のスコープを宣言している（`scopes.ts`）と、許可した一覧に無い値をグラントに含めず、`invalid_scope` で拒否する（RFC 6749 §3.3 / §4.1.2.1）。
    // 宣言していなければ、どの値も受け付ける。
    // この確認は、意図して `applyOfflineAccessPolicy()` の後に置いている。
    // ポリシーがすでに取り除いた `offline_access` を「無視した」ままにし（OIDC Core 1.0 §11）、リクエストを `invalid_scope` にしないためである。
    const unsupportedScopes = findUnsupportedScopes(scope);
    if (unsupportedScopes.length > 0) {
      throw new AuthorizationError(
        AuthorizationErrorCode.InvalidScope,
        'Unsupported scope: ' + unsupportedScopes.join(' '),
        redirectUri,
        state,
      );
    }

    // `display` が `page`、`popup`、`touch`、`wap` のどれかであることを確かめる（OIDC Core 1.0 §3.1.2.1）。
    const display = validateDisplayParameter(requestParams, redirectUri, state);

    // `max_age` をリクエストから取り出し、無ければクライアントが登録した `default_max_age` を使う（OIDC Core 1.0 §3.1.2.1、OIDC Dynamic Client Registration 1.0 §2）。
    // 登録した `default_max_age` が不正なら、設定の誤りとして、リダイレクトしない `server_error` を投げる。
    const maxAge = resolveMaxAge(requestParams, client, redirectUri, state);

    // アクセストークンのオーディエンスを、空白で区切った `audience` から取り出す。
    const audience = parseAudienceParameter(requestParams);

    // `claims` パラメータを解析し、`userinfo` と `id_token` の要求を取り出す（OIDC Core 1.0 §5.5）。
    const claims = parseClaimsRequestParameter(requestParams, redirectUri, state);

    // `acr_values` を検証する（OIDC Core 1.0 §3.1.2.1）。
    // `acr_values` は省略でき、優先する順に空白で区切った `acr` の値で、各値は `"` と `\` 以外の表示できる ASCII 文字からなる。
    // トークンエンドポイントは、決めた `acr` を ID トークンとアクセストークンに入れる（`token/route.ts`）。
    const acrValues = validateAcrValuesParameter(requestParams, redirectUri, state);

    // [validate-implicit-request] (feature: implicit-flow) インプリシットフローのリクエストを検証する — OIDC Core 1.0 §3.2.2.1 / OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5
    validateImplicitRequest({ responseType, nonce: requestParams.nonce, redirectUri, state }, requestParams, client, responseMode);

    // [validate-hybrid-request] (feature: hybrid-flow) ハイブリッドフローのリクエストを検証する — OIDC Core 1.0 §3.3.2.1 / §3.3.2.11 / OAuth 2.0 Multiple Response Type Encoding Practices §5
    validateHybridRequest({ responseType, nonce: requestParams.nonce, redirectUri, state }, requestParams, responseMode);

    // [create-transaction] 認可トランザクションを作って保存する — OIDC Core 1.0 §3.1.2.3
    // 各検証の結果から、検証済みのリクエストを組み立てる。
    // 形は core の `ValidatedAuthorizationRequest`（`createAuthTransaction()` が受け取る型）なので、上の検証を足したり消したりしても、後の処理（トランザクション、認可コード）は影響を受けない。
    const validatedRequest = {
      responseType,
      clientId: client.clientId,
      redirectUri,
      // `redirect_uri` を明示して送ったリクエストでは、トークンリクエストにも同じ `redirect_uri` が要るので、どちらだったかを記録する（OIDC Core 1.0 §3.1.3.2）。
      redirectUriExplicit: requestParams.redirect_uri !== undefined,
      scope,
      codeChallenge: pkce.codeChallenge,
      codeChallengeMethod: pkce.codeChallengeMethod,
      state,
      nonce: requestParams.nonce,
      prompt,
      display,
      maxAge,
      uiLocales: requestParams.ui_locales,
      claimsLocales: requestParams.claims_locales,
      acrValues,
      loginHint: requestParams.login_hint,
      idTokenHint: requestParams.id_token_hint,
      audience,
      claims,
    };

    // ログインと同意のあいだリクエストを保持するトランザクションを、検証済みのリクエストと新しい CSRF トークンから作る。
    // CSRF トークンは、ログインフォームと同意画面のフォームに埋め込む。
    // トランザクション ID は、`HttpOnly` のトランザクションの Cookie（`_oidc-provider/cookies.ts` の `buildTransactionCookie()`）でしか OP の外へ出さない。
    const csrfToken = generateRandomString(32);
    const transaction = createAuthTransaction(validatedRequest, csrfToken);
    const transactionId = generateRandomString(32);
    const transactionTtlSeconds = 10 * 60;
    // 同意のステップはストアから読み戻したトランザクションしか使わないので、求められたレスポンスモードの名前をトランザクションに記録してから、10 分間保存する。
    // そのため、トランザクションのストアは、型に定義されていないフィールドも捨てずに保存する必要がある。
    const storedTransaction: ResponseModeTransaction = responseMode
      ? { ...transaction, responseMode: responseMode.name }
      : transaction;
    await transactionStore.put('auth_txn:' + transactionId, storedTransaction, transactionTtlSeconds);

    // [validate-prompt-combination] ほかの値と併用された prompt=none を拒否する — OIDC Core 1.0 §3.1.2.1
    // `prompt` は空白で区切った値の並びなので、空白で分けて配列にする（OIDC Core 1.0 §3.1.2.1）。
    const promptValues = transaction.prompt?.trim().split(/\s+/).filter(Boolean) ?? [];

    // `prompt=none` がほかの値と並んでいれば、トランザクションを削除し、`invalid_request` のエラーの認可レスポンスを返す（OIDC Core 1.0 §3.1.2.1）。
    if (promptValues.includes('none') && promptValues.length > 1) {
      await transactionStore.delete('auth_txn:' + transactionId);
      return await errorRedirect(responseMode, transaction.redirectUri, 'invalid_request', transaction.state, 'prompt=none must not be combined with other prompt values');
    }

    // [verify-id-token-hint] id_token_hint を検証する — OIDC Core 1.0 §3.1.2.1
    // `id_token_hint` があれば、署名、`iss`、`aud`、`exp`、`iat` を OP 自身の ID トークンの署名鍵で検証し、サブジェクトを取り出す。
    // 検証に失敗すると、トランザクションを削除し、エラーの認可レスポンス（`login_required`）を返す。
    // `id_token_hint` についての規定（「ID トークンが示すエンドユーザーがログインしていれば…そうでなければエラーを返すべき（SHOULD）」）は、`prompt` を条件にしていない（OIDC Core 1.0 §3.1.2.1）。
    // そのため、`prompt=none` の分岐の外のここで、`prompt` の値によらず検証する。
    // 検証したサブジェクトは下の `prompt=none` の確認と SSO の両方で使うので、検証していない `id_token_hint` がセッションの判断に使われることはない。
    let verifiedHintSubject: string | undefined;
    if (transaction.idTokenHint !== undefined) {
      try {
        const verified = await validateIdTokenHint(transaction.idTokenHint, {
          expectedIss: issuer,
          expectedAud: transaction.clientId,
          jwks: await idTokenHintJwks(keys),
        });
        verifiedHintSubject = verified.sub;
      } catch (hintError) {
        await transactionStore.delete('auth_txn:' + transactionId);
        const code = hintError instanceof IdTokenHintError ? hintError.error : 'login_required';
        return await errorRedirect(responseMode, transaction.redirectUri, code, transaction.state, hintError instanceof Error && hintError.message ? hintError.message : 'id_token_hint verification failed');
      }
    }

    // [authenticate-silently] prompt=none: 画面を出さずに認証する — OIDC Core 1.0 §3.1.2.1
    if (promptValues.includes('none')) {
      let session;
      try {
        // `prompt=none` の確認では、core の独立した関数を、セッション、`id_token_hint`、同意の順に呼ぶ。
        // `id_token_hint` を同意より前に確かめるのは、別のエンドユーザーの同意を照会しないためである。
        // 確認を一つ外すにはその呼び出しを消し、独自の処理を足すには呼び出しの間に差し込む。
        // どの関数も、失敗すると `AuthorizationError`（`login_required` か `consent_required`）を投げる。

        // 有効なセッションを取得し、無ければ `login_required` を投げる。
        // `prompt=none` ではログイン画面を出せないためである（OIDC Core 1.0 §3.1.2.1）。
        session = await resolvePromptNoneSession(transaction, sessionResolver, request);

        // `id_token_hint` のサブジェクトがセッションのサブジェクトと違えば、`login_required` を投げる。
        // `verifiedHintSubject` は、`prompt` によらない前のブロックで検証済みなので、ここでは一致だけを確かめる。
        // 同意の照会は `session.subject` をキーにするので、この確認を同意の確認より前に置く。
        // 一致しないまま進むと、別のユーザーの同意を照会してしまう。
        validatePromptNoneIdTokenHint(transaction, session, verifiedHintSubject);

        // 同意を照会する前に、スコープのポリシーで `transaction.scope` を、このエンドユーザーに許すスコープだけに絞る。
        // このエンドユーザーが決して得られないスコープまで含めて照会すると、いつまでも `consent_required` になる（OIDC Core 1.0 §3.1.2.1）。
        // ユーザーごとの絞り込みは、`scopes.ts` の `resolveGrantableScopes()` に書く。
        transaction.scope = (await resolveGrantableScopes(
          transaction.scope.split(' ').filter(Boolean),
          session.subject,
        )).join(' ');

        // 要求されたスコープに同意していなければ、`consent_required` を投げる。
        // `prompt=none` では同意画面を出せないためである（OIDC Core 1.0 §3.1.2.1）。
        await validatePromptNoneConsent(transaction, session, consentResolver);
      } catch (promptError) {
        await transactionStore.delete('auth_txn:' + transactionId);
        if (promptError instanceof AuthorizationError) {
          return await errorRedirect(responseMode, transaction.redirectUri, promptError.error, transaction.state, promptError.errorDescription);
        }
        const serverDescription =
          promptError instanceof Error && promptError.message
            ? promptError.message
            : 'Unexpected error while evaluating prompt=none';
        return await errorRedirect(responseMode, transaction.redirectUri, 'server_error', transaction.state, serverDescription);
      }

      // セッションが `max_age` より古ければ、トランザクションを削除し、`login_required` のエラーの認可レスポンスを返す。
      // 認証し直すには画面が要るので、`prompt=none` では行えない（OIDC Core 1.0 §3.1.2.1）。
      if (transaction.maxAge !== undefined && requiresReauthentication(transaction.maxAge, session.authTime)) {
        await transactionStore.delete('auth_txn:' + transactionId);
        return await errorRedirect(responseMode, transaction.redirectUri, 'login_required', transaction.state, 'Session exceeds the requested max_age; re-authentication required');
      }

      return await issueAuthorizationResponse(transactionId, transaction, session, responseMode);
    }

    // [reuse-session] SSO: 有効な OP のセッションを再利用する — OIDC Core 1.0 §3.1.2.3
    // OP の有効なセッションがあれば、ログイン画面を出さずに再利用する（SSO、OIDC Core 1.0 §3.1.2.3）。
    // `prompt=login` と `prompt=select_account` では、必ず認証し直させるので再利用しない。
    // `max_age` があれば、セッションの認証時刻がそれより新しいことも求める（同 §3.1.2.1）。
    if (!promptValues.includes('login') && !promptValues.includes('select_account')) {
      const existingSession = await sessionResolver.resolve(request);
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
      if (existingSession && sessionIsFresh && hintMatchesSession) {
        // 下の同意の照会より前に、スコープのポリシーで `transaction.scope` を、このエンドユーザーに許すスコープだけに絞る。
        // 得られないスコープを含めたまま照会すると、同意済みと判定されないためである（`prompt=none` のときと同じ理由）。
        // 絞った値はストアに書き戻さず、この処理の中でだけ使う。
        // 同意画面へ移るときは、同意のステップが、許可する内容にポリシーをもう一度適用する。
        transaction.scope = (await resolveGrantableScopes(
          transaction.scope.split(' ').filter(Boolean),
          existingSession.subject,
        )).join(' ');

        // `prompt=consent` なら、同意画面を必ず表示し直す（OIDC Core 1.0 §3.1.2.1）。
        // そうでなく、ユーザーが要求されたスコープ（またはそれを含むスコープ）にこのクライアントへすでに同意していれば、同意画面を飛ばして認可コードを発行する。
        const consentAlreadyGranted =
          !promptValues.includes('consent') &&
          (await consentResolver.hasConsent(
            existingSession.subject,
            transaction.clientId,
            transaction.scope.split(' ').filter(Boolean),
          ));

        if (consentAlreadyGranted) {
          return await issueAuthorizationResponse(transactionId, transaction, existingSession, responseMode);
        }

        // ログイン済みなので、認証済みのサブジェクトを `authSessionStore` に保存して同意のステップへ渡す。
        await authSessionStore.set(transactionId, {
          subject: existingSession.subject,
          authTime: existingSession.authTime,
          // 同意画面を経由しても、オンラインのリフレッシュトークンを結び付けるセッションが分かるよう、同意画面へ渡す値にセッション ID も入れる。
          sessionId: existingSession.sessionId,
        });
        return redirectToScreen('/consent', transactionId, transactionTtlSeconds);
      }
    }

    // [continue-to-login] ログイン画面へ進む — OIDC Core 1.0 §3.1.2.3
    // 対話で認証させるため、トランザクションの Cookie を付けてログイン画面へリダイレクトする。
    // `prompt=login` のリクエストは、セッションがあってもここへ来る。
    return redirectToScreen('/login', transactionId, transactionTtlSeconds);
  } catch (error) {
    // [respond-error] 失敗をリダイレクトか OP 上のエラーに振り分ける — OIDC Core 1.0 §3.1.2.6 / RFC 6749 §4.1.2.1
    if (error instanceof AuthorizationError) {
      if (error.redirectUri) {
        return await errorRedirect(responseMode, error.redirectUri, error.error, error.state, error.errorDescription);
      }
      // リダイレクトできないエラー（未知の `client_id`、登録されていない `redirect_uri`、フラグメントを含む `redirect_uri`）は、リクエストの `redirect_uri` へ送らず、OP で応答する（OIDC Core 1.0 §3.1.2.2）。
      return nonRedirectableError(request, error.error, error.errorDescription);
    }
    return Response.json({ error: 'server_error' }, { status: 500 });
  }
}

/**
 * 認可コードを発行し、認可レスポンスで応答する。
 *
 * 画面の要らないリクエスト（`prompt=none`、または以前に同意したエンドユーザーの SSO）から呼ばれる。
 * インプリシットフローかハイブリッドフローの機能がレスポンスタイプに応答すれば、その機能の応答を返す。
 * そうでなければ、トランザクションを削除してから認可コードを作ってストアに保存し、エンドユーザー、クライアント、グラント ID の組を同意リゾルバに記録して、認可コードを含む認可レスポンスで応答する。
 *
 * `transaction.scope` は、認可リクエストの検証で `applyOfflineAccessPolicy()` を通した後の値である。
 * `offline_access` を残すかどうか（OIDC Core 1.0 §11 の `prompt=consent` と、クライアント登録の `grant_types` に `refresh_token` があるか）はそこで判定済みなので、ここではスコープを絞り直さない。
 *
 * @spec OIDC Core 1.0 §3.1.2.5
 * @spec OIDC Core 1.0 §3.1.3.1
 * @spec RFC 9207 §2
 */
async function issueAuthorizationResponse(
  transactionId: string,
  transaction: AuthTransaction,
  session: SessionInfo,
  responseMode: AuthorizationResponseMode | undefined,
): Promise<Response> {
  // [issue-implicit-response] (feature: implicit-flow) インプリシットフロー: トークンを直接発行する — OIDC Core 1.0 §3.2.2.5
  const implicitResponse = await issueImplicitResponse({ transactionId, transaction, session, responseMode });
  if (implicitResponse) return implicitResponse;

  // [issue-hybrid-response] (feature: hybrid-flow) ハイブリッドフロー: コードとトークンを発行する — OIDC Core 1.0 §3.3.2.5
  const hybridResponse = await issueHybridResponse({ transactionId, transaction, session, responseMode });
  if (hybridResponse) return hybridResponse;

  // [issue-authorization-code] 認可コードを発行する — OIDC Core 1.0 §3.1.2.5 / §3.1.3.1
  const grantedScope = transaction.scope.split(' ').filter(Boolean);
  const responseParams = await completeAuthTransaction(transactionId, transaction, transactionStore);
  const authCodeData = await createAuthorizationCode({
    authorizationResponse: { ...responseParams, scope: grantedScope },
    subject: session.subject,
    authTime: session.authTime,
    // オンラインのリフレッシュトークンをこのログインセッション（`prompt=none` や SSO で再利用したもの）に結び付けるため、セッション ID を引き継ぐ。
    // セッションが終わると、そのリフレッシュトークンは `invalid_grant` になる。
    sessionId: session.sessionId,
    // 認可コードの有効期間は `ProviderConfig` の `authorizationCodeTtl` で設定でき、既定は 300 秒である（OIDC Core 1.0 §3.1.3.1）。
    ttlSeconds: config.authorizationCodeTtl,
  });
  await authCodeStore.set(authCodeData.code, authCodeData);
  // エンドユーザー、クライアント、グラント ID の組を記録する。
  // 同意を取り消すと、このグラントから発行したトークンも失効する。
  await consentResolver.recordGrant(session.subject, transaction.clientId, authCodeData.grantId);

  return successRedirect(responseMode, transaction.redirectUri, authCodeData.code, transaction.state);
}

/**
 * `client_id` が文字列のオブジェクトなら `true` を返す。
 *
 * `true` のとき、引数の型を `AuthorizationRequestParams` に絞る。
 * 確かめるのは `client_id` だけで、PKCE のパラメータは後で core の関数が検証する。
 * そのため、OIDF の適合性テストとの互換モード（`allowNonPkceAuthorizationCodeFlow`）では、PKCE のパラメータを省いたリクエストを意図して通せる。
 */
function isAuthorizationRequestParams(params: unknown): params is AuthorizationRequestParams {
  if (typeof params !== 'object' || params === null) return false;
  return typeof (params as Record<string, unknown>)['client_id'] === 'string';
}

/**
 * `invalid_request` を 400 の JSON で返す。
 *
 * リクエストの形式の誤り（`POST` の `Content-Type` の誤り、パラメータの重複、`client_id` の欠落）に使う。
 * まだトランザクションが無く、画面に表示するものが無いので、画面ではなく OAuth のエラーレスポンスで応答する。
 */
function badRequest(errorDescription: string): Response {
  return Response.json({ error: 'invalid_request', error_description: errorDescription }, { status: 400 });
}

/**
 * ログイン画面か同意画面へ 302 でリダイレクトする。
 *
 * Set the transaction cookie and carry its random ID in the URL.
 * The destination screen rejects the request unless both references match.
 *
 * URL はリクエストの URL ではなく `config.issuer` から作る。
 * 実行環境によってはリクエストの URL を `Host` ヘッダーから求めるので、リクエストの URL から作ると、送信者がリダイレクト先のオリジンを選べてしまう（OIDC Discovery 1.0 §3、RFC 9700 §2.1）。
 */
function redirectToScreen(
  path: '/login' | '/consent',
  transactionId: string,
  ttlSeconds: number,
): Response {
  const response = NextResponse.redirect(new URL(buildTransactionPath(path, transactionId), config.issuer), 302);
  response.headers.append('Set-Cookie', buildTransactionCookie(transactionId, ttlSeconds));
  return response;
}

/**
 * リダイレクトできないエラーに、OP で応答する。
 *
 * クライアントへ返せないエラーは、OP で応答する（OIDC Core 1.0 §3.1.2.2）。
 * `Accept` ヘッダーが `application/json` を含めば、400 の JSON で OAuth のエラーレスポンスを返す。
 * そうでなければ、ブラウザを OP のエラー画面（`app/oidc-error/page.tsx`）へ 303 でリダイレクトする。
 * OIDF の適合性テストの `oidcc-ensure-registered-redirect-uri` は、このエラー画面のスクリーンショットを撮る。
 *
 * @spec OIDC Core 1.0 §3.1.2.2
 */
function nonRedirectableError(request: Request, error: string, errorDescription?: string): Response {
  if ((request.headers.get('Accept') ?? '').includes('application/json')) {
    return Response.json({ error, error_description: errorDescription }, { status: 400 });
  }
  return redirectToErrorPage(error, errorDescription);
}

/**
 * パラメータを認可レスポンスにしてクライアントに返す。
 *
 * リクエストが求めたレスポンスモード（JARM の `query.jwt`、`form_post` のフォームなど）があれば、そのモードで返す。
 * 無ければ、パラメータをクエリに入れ、`iss` を加えてリダイレクトする（RFC 9207 §2）。
 */
async function redirectToClient(
  responseMode: AuthorizationResponseMode | undefined,
  redirectUri: string,
  parameters: Record<string, string | undefined>,
): Promise<Response> {
  return respondToClient(await authorizationResponseOf(responseMode, redirectUri, parameters, config.issuer));
}

/**
 * エラーの認可レスポンスでクライアントに応答する。
 *
 * レスポンスには `error`、`error_description`、`state` を入れる。
 * `errorDescription` は、RFC 6749 §5.2 が許す文字以外を `?` に置き換えてから使う。
 * 説明文にリクエストの値が入っても、制御文字などを URL に紛れ込ませないためである。
 *
 * @spec OIDC Core 1.0 §3.1.2.6
 * @spec RFC 6749 §4.1.2.1
 */
function errorRedirect(
  responseMode: AuthorizationResponseMode | undefined,
  redirectUri: string,
  error: string,
  state?: string,
  errorDescription?: string,
): Promise<Response> {
  return redirectToClient(responseMode, redirectUri, {
    error,
    error_description: errorDescription ? sanitizeErrorDescription(errorDescription) : undefined,
    state,
  });
}

/**
 * 認可コードを含む認可レスポンスで応答する。
 *
 * レスポンスには `code` と `state` を入れる。
 *
 * @spec OIDC Core 1.0 §3.1.2.5
 */
function successRedirect(
  responseMode: AuthorizationResponseMode | undefined,
  redirectUri: string,
  code: string,
  state: string | undefined,
): Promise<Response> {
  return redirectToClient(responseMode, redirectUri, { code, state });
}
