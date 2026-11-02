/**
 * The (feature: implicit-flow) blocks of authorize/route.ts: the response
 * mode of a request of the Implicit Flow (response_type=id_token or id_token
 * token, OIDC Core 1.0 §3.2.2.1), what such a request needs on top of the
 * validation of the code flow, and its tokens in place of the code for a
 * request that needs no screen (prompt=none, or SSO with prior consent).
 */
import {
  completeAuthTransaction,
  defaultResponseModeOf,
  isImplicitResponseType,
  requireNonce,
  validateImplicitRedirectUri,
  validateImplicitResponseMode,
  type AuthorizationRequestParams,
  type AuthTransaction,
  type ClientInfo,
  type SessionInfo,
} from '@maronn-openid-connect/core';
import { respondToClient, type AuthorizationResponseMode } from '../../../authorize/response-mode';
import { config, loadSigningKeys, resolvers, stores } from '../../provider';
import { createFragmentResponseMode, FRAGMENT_RESPONSE_MODE_NAME, implicitResponseModeOf } from './response-mode';
import { issueImplicitTokens } from './tokens';

/**
 * フラグメントで返すリクエストならそのモードを返す。
 *
 * 次のどちらかに当たるリクエストに、フラグメントのレスポンスモードを返す。
 * - `response_mode=fragment` を指定している（OAuth 2.0 Multiple Response Type Encoding Practices §2.1）。
 * - `response_type` の既定のレスポンスモードがフラグメントである（OAuth 2.0 Multiple Response Type Encoding Practices §3、§5）。
 *
 * 既定がフラグメントになるのは、ID トークンかアクセストークンを返すレスポンスタイプである。
 * インプリシットフローの `id_token` と `id_token token` のほか、`hybrid-flow` 機能が扱うハイブリッドフローの `code id_token`、`code token`、`code id_token token` も当たる（`hybrid-flow` 機能はこの機能を必要とする）。
 * どちらにも当たらないリクエストには `undefined` を返し、パラメータをクエリに付ける通常のレスポンスに任せる。
 *
 * ルートハンドラは、名前で要求されるレスポンスモード（JARM、`form_post`）のブロックのあとに、このブロックを実行する。
 * どのブロックの結果も、レスポンスモードがまだ決まっていないときだけ使うので、`response_mode=form_post` を指定したインプリシットフローのリクエストはフォームで POST される。
 * ここでレスポンスモードが決まると、以降のエラーはフラグメントで返る（OIDC Core 1.0 §3.2.2.6）。
 * `validateImplicitRequest()` が `response_mode=query` を拒否するエラーも同じである。
 *
 * @spec OAuth 2.0 Multiple Response Type Encoding Practices §2.1
 */
export function resolveFragmentResponseContext(
  params: AuthorizationRequestParams,
  issuer: string,
): AuthorizationResponseMode | undefined {
  const requested = (params as { response_mode?: unknown }).response_mode;
  if (requested === FRAGMENT_RESPONSE_MODE_NAME) return createFragmentResponseMode({ issuer });
  if (params.response_type !== undefined && defaultResponseModeOf(params.response_type) === 'fragment') {
    return createFragmentResponseMode({ issuer });
  }
  return undefined;
}

/**
 * インプリシットフローに固有の条件を検証する。
 *
 * `response_type` がインプリシットフローのもの（`id_token` か `id_token token`）でなければ、何もしない。
 * 検証はトランザクションを作る前に行い、次の条件をそれぞれ core の関数で確かめる。
 * - トークンをクエリに含めないよう、`response_mode=query` を拒否する（OAuth 2.0 Multiple Response Type Encoding Practices §3、§5、§7）。
 * - OP がこのリクエストに使うレスポンスモード（`responseMode`）と異なる `response_mode`（JARM の `query.jwt` や未知の値）も、フラグメントに置き換えずに拒否する。
 * - `nonce` を必須とする（OIDC Core 1.0 §3.2.2.1）。
 * - `redirect_uri` に `http` のスキームを使えるのは、パブリック（ネイティブ）クライアントがループバックのホストを指定したときだけとする（OIDC Core 1.0 §3.2.2.1）。
 *
 * 違反には、リダイレクトで返せる `invalid_request` を投げる。
 * ルートハンドラは、このエラーをリクエストのレスポンスモード（既定はフラグメント）でクライアントへ返す（OIDC Core 1.0 §3.2.2.6）。
 *
 * @throws {AuthorizationError} `invalid_request`: 上のどれかの条件に違反するとき。
 * @spec OIDC Core 1.0 §3.2.2.1
 */
export function validateImplicitRequest(
  request: { responseType: string; nonce: string | undefined; redirectUri: string; state: string | undefined },
  params: AuthorizationRequestParams,
  client: ClientInfo,
  responseMode: AuthorizationResponseMode | undefined,
): void {
  if (!isImplicitResponseType(request.responseType)) return;
  const { redirectUri, state } = request;

  const requested = (params as { response_mode?: unknown }).response_mode;
  validateImplicitResponseMode(
    typeof requested === 'string' ? requested : undefined,
    responseMode === undefined ? [] : [responseMode.name],
    redirectUri,
    state,
  );
  requireNonce(request.nonce, redirectUri, state);
  validateImplicitRedirectUri(redirectUri, client.clientType, state);
}

/**
 * トークンを発行し、認可レスポンスで応答する。
 *
 * 対象は、画面を出さずに応答できるインプリシットフローのリクエスト（`prompt=none` か、同意済みの SSO）である。
 * ほかのレスポンスタイプには `undefined` を返し、あとのブロック（ハイブリッドフローか認可コードの発行）に任せる。
 *
 * トランザクションを終え、そのスコープで ID トークン（`id_token token` ではアクセストークンも）を発行し、グラントを記録する。
 * 認可レスポンスは `responseMode` で返し、ないときはフラグメントで返す（OIDC Core 1.0 §3.2.2.5）。
 * クエリでは返さない。
 *
 * `transaction.scope` は、スコープの方針（`scopes.ts` の `resolveGrantableScopes()`）を通したあとの値である。
 * 認可コードを返さないレスポンスタイプでは `applyOfflineAccessPolicy()` が `offline_access` を取り除くので、`transaction.scope` に `offline_access` は含まれない（OIDC Core 1.0 §11）。
 *
 * @throws {AuthorizationError} `server_error`: クライアントが登録した `alg` の ID トークンの署名鍵がないとき（`issueImplicitTokens()`）。
 * @throws {Error} 署名鍵を読み込めないとき（`loadSigningKeys()`）。
 *   このときトランザクションは終えずに残す。
 */
export async function issueImplicitResponse(input: {
  transactionId: string;
  transaction: AuthTransaction;
  session: SessionInfo;
  responseMode: AuthorizationResponseMode | undefined;
}): Promise<Response | undefined> {
  const { transactionId, transaction, session, responseMode } = input;
  if (!isImplicitResponseType(transaction.responseType)) return undefined;

  // トランザクションを終える前に、署名鍵を読み込む。
  // 鍵を読み込めないときに、トランザクションを元のまま残すためである。
  const keys = await loadSigningKeys();
  const grantedScope = transaction.scope.split(' ').filter(Boolean);

  // トランザクションは一度しか使えないので、何かを発行する前に終える。
  const responseParams = await completeAuthTransaction(transactionId, transaction, stores.transactionStore);
  const { parameters, grantId } = await issueImplicitTokens({
    responseType: transaction.responseType,
    responseParams,
    session,
    grantedScope,
    keys,
  });
  // グラントを記録する。
  // 同意を取り消すと、このグラントのアクセストークンが失効する。
  await resolvers.consentResolver.recordGrant(session.subject, transaction.clientId, grantId);

  const mode = implicitResponseModeOf(responseMode, config.issuer);
  return respondToClient(await mode.respond(transaction.redirectUri, parameters));
}
