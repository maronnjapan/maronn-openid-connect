import {
  type AuthorizationRequestParams,
  type ClientInfo,
  type ResolvedRequestObjectParams,
  AuthorizationError,
  AuthorizationErrorCode,
  rejectUnsupportedRequestParams,
  validateRequestObjectConsistency,
  validateResponseType,
  validateAuthorizationScope,
  validateClientScope,
  validateAuthorizationCodePkce,
  validatePromptParameter,
  applyOfflineAccessPolicy,
  validateDisplayParameter,
  resolveMaxAge,
  parseAudienceParameter,
  parseClaimsRequestParameter,
  validateAcrValuesParameter,
  responseTypeIncludes,
  type ValidatedAuthorizationRequest,
} from '@maronn-openid-connect/core';
import { features } from '../../../features/enabled.js';
import { tokenGrantsOf } from '../../../features/feature.js';
import { findUnsupportedScopes } from '../../../scopes.js';
import type { AuthorizationRequestInput } from '../outcome.js';
import { supportedResponseTypes } from '../response-type.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'validate-request',
  endpoint: 'authorize',
  kind: 'validate',
  label: 'リクエストのパラメータを検証する',
  spec: 'OIDC Core 1.0 §3.1.2.1-§3.1.2.2 / OAuth 2.1 §4.1.1 / §7.5',
  function: 'validateAuthorizationRequestParams',
  consumes: ['params', 'effectiveParams', 'requestObjectClaims', 'client', 'redirectUri', 'state'],
  optional: ['effectiveParams', 'requestObjectClaims'],
  produces: ['validatedRequest'],
  removable: false,
});

/**
 * パラメータを検証し、検証済みのリクエストを返す。
 *
 * 検証はそれぞれ core の独立した関数で、OIDC Core 1.0 §3.1.2 の順に呼ぶ。
 * 検証を一つ外すにはその呼び出しを消し、独自の処理を足すには二つの検証の間に差し込む。
 *
 * このステップより前に `redirect_uri` を確かめているので、ここでの失敗はリダイレクトでき、エラーはリクエストの `state` と一緒にクライアントへ返る。
 * ただし、クライアントが登録した `default_max_age` が不正なときは、設定の誤りとして、リダイレクトしない `server_error` を投げる。
 *
 * @throws {AuthorizationError} 検証に失敗したとき（`invalid_request`、`invalid_scope`、`unsupported_response_type`、`unauthorized_client`、`request_not_supported` など）。
 *
 * @spec OIDC Core 1.0 §3.1.2.1
 * @spec OIDC Core 1.0 §3.1.2.2
 * @spec OAuth 2.1 §4.1.1
 * @spec OAuth 2.1 §7.5
 */
export async function validateAuthorizationRequestParams(
  c: any,
  input: {
    /** The parameters as sent (OAuth query parameters). */
    params: AuthorizationRequestInput;
    /**
     * The parameters after the Request Object overlay (OIDC Core 1.0 §6.1).
     * undefined when the provider has no request-object feature: the query
     * parameters are then the request, and a `request` parameter is rejected
     * with request_not_supported (§6.3).
     */
    effectiveParams: AuthorizationRequestParams | undefined;
    requestObjectClaims: ResolvedRequestObjectParams['requestObjectClaims'];
    client: ClientInfo;
    redirectUri: string;
    state: string | undefined;
  },
): Promise<ValidatedAuthorizationRequest> {
  const { params, requestObjectClaims, client, redirectUri, state } = input;
  const effectiveParams = input.effectiveParams ?? params;
  const config = c.get('config');

  // `request_uri` と `registration` には対応していないので拒否する（OIDC Core 1.0 §6.3）。
  // `request` は、前のステップでリクエストオブジェクトを処理したとき（`effectiveParams` があるとき）だけ通し、それ以外は拒否する。
  rejectUnsupportedRequestParams(params, redirectUri, state, {
    requestParameterSupported: input.effectiveParams !== undefined,
  });

  // リクエストオブジェクトの中の `response_type` と `client_id` が、OAuth のクエリパラメータと一致することを確かめる（OIDC Core 1.0 §6.1）。
  validateRequestObjectConsistency(params, requestObjectClaims, redirectUri, state);

  // `response_type` が、OP の応答するレスポンスタイプのどれかで、しかもクライアントに登録されていることを確かめる。
  // OP が応答するのは、`code` と、機能が応答するレスポンスタイプ（`response-type.ts` の `supportedResponseTypes()`）である。
  const responseType = validateResponseType(params, client, redirectUri, state, supportedResponseTypes());

  // `scope` がクエリにあり（OIDC Core 1.0 §6.1）、`openid` を含む（同 §3.1.2.1）ことを確かめ、スコープを取り出す。
  let scope = validateAuthorizationScope(params, effectiveParams, redirectUri, state);

  // スコープの一覧（`client.scope`）を登録したクライアントは、その一覧のスコープしか要求できない（RFC 7591 §2）。
  // 一覧に無いスコープは、`offline_access` も含めて `invalid_scope` で拒否する。
  validateClientScope(scope, client.scope, redirectUri, state);

  // `S256` の PKCE を検証する（OAuth 2.1 §4.1.1 / §7.5）。
  // `allowNonPkceAuthorizationCodeFlow` は、OIDF の適合性テスト（`Basic OP` の静的クライアント）との互換のためだけにあり、コンフィデンシャルクライアントが PKCE のパラメータをすべて省いたときだけ PKCE なしを許す。
  // PKCE は認可コードに結び付けるものなので、認可コードを返さないレスポンスタイプ（インプリシットフロー、OIDC Core 1.0 §3.2）では検証しない。
  const pkce = responseTypeIncludes(responseType, 'code')
    ? validateAuthorizationCodePkce(effectiveParams, client, redirectUri, state, {
      allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow,
    })
    : { codeChallenge: undefined, codeChallengeMethod: undefined };

  // `prompt` の各値が `none`、`login`、`consent`、`select_account` のどれかであることを確かめる（OIDC Core 1.0 §3.1.2.1）。
  // `none` とほかの値の併用も、`invalid_request` で拒否する。
  const prompt = validatePromptParameter(effectiveParams, redirectUri, state);

  // `offline_access` は、次の二つの条件を両方満たしたときだけスコープに残す。
  // - エンドユーザーが同意する（`prompt=consent`、OIDC Core 1.0 §11）。
  // - クライアント登録の `grant_types` に `refresh_token` がある（既定は `["authorization_code"]`、RFC 7591 §2）。
  // 二つ目の条件が無いと、発行したリフレッシュトークンは `unauthorized_client` で拒否されるだけの、使えない認証情報になる。
  // どちらの条件も、この OP が `refresh_token` のグラントを受け付ける（`refresh-token` の機能がある）ときに限る。
  // 受け付けないなら、コールバックが常に `false` を返し、`offline_access` を常に無視する（OIDC Core 1.0 §11）。
  // 認可コードを返さない `response_type`（インプリシットフロー）の `offline_access` は、`applyOfflineAccessPolicy()` がコールバックによらず無視する（同 §11）。
  // 独自の許可条件を使うなら、コールバックを渡す（コールバックは `client` も受け取る）:
  //   `scope = await applyOfflineAccessPolicy(scope, effectiveParams, prompt, client,`
  //   `  (req, { promptValues }) => promptValues.includes('consent') || hasStoredConsent(req));`
  const refreshTokensOffered = tokenGrantsOf(features).includes('refresh_token');
  scope = await applyOfflineAccessPolicy(
    scope,
    effectiveParams,
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
  const display = validateDisplayParameter(effectiveParams, redirectUri, state);

  // `max_age` をリクエストから取り出し、無ければクライアントが登録した `default_max_age` を使う（OIDC Core 1.0 §3.1.2.1、OIDC Dynamic Client Registration 1.0 §2）。
  // 登録した `default_max_age` が不正なら、設定の誤りとして、リダイレクトしない `server_error` を投げる。
  const maxAge = resolveMaxAge(effectiveParams, client, redirectUri, state);

  // アクセストークンのオーディエンスを、空白で区切った `audience` から取り出す。
  const audience = parseAudienceParameter(effectiveParams);

  // `claims` パラメータを解析し、`userinfo` と `id_token` の要求を取り出す（OIDC Core 1.0 §5.5）。
  const claims = parseClaimsRequestParameter(effectiveParams, redirectUri, state);

  // `acr_values` を検証する（OIDC Core 1.0 §3.1.2.1）。
  // `acr_values` は省略でき、優先する順に空白で区切った `acr` の値で、各値は `"` と `\` 以外の表示できる ASCII 文字からなる。
  // トークンエンドポイントは、決めた `acr` を ID トークンとアクセストークンに入れる（`endpoints/token/` の `resolve-acr-amr` ステップ）。
  const acrValues = validateAcrValuesParameter(effectiveParams, redirectUri, state);

  // 各検証の結果から、検証済みのリクエストを組み立てる。
  // 形は core の `ValidatedAuthorizationRequest`（`createAuthTransaction()` が受け取る型）なので、上の検証を足したり消したりしても、後の処理（トランザクション、認可コード）は影響を受けない。
  const validatedRequest = {
    responseType,
    clientId: client.clientId,
    redirectUri,
    // `redirect_uri` を明示して送ったリクエストでは、トークンリクエストにも同じ `redirect_uri` が要るので、どちらだったかを記録する（OIDC Core 1.0 §3.1.3.2）。
    redirectUriExplicit: effectiveParams.redirect_uri !== undefined,
    scope,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
    state,
    nonce: effectiveParams.nonce,
    prompt,
    display,
    maxAge,
    uiLocales: effectiveParams.ui_locales,
    claimsLocales: effectiveParams.claims_locales,
    acrValues,
    loginHint: effectiveParams.login_hint,
    idTokenHint: effectiveParams.id_token_hint,
    audience,
    claims,
  };
  return validatedRequest;
}
