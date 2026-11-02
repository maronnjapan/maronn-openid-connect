/**
 * The (feature: hybrid-flow) blocks of authorize/route.ts: what a request of
 * the Hybrid Flow (response_type=code id_token, code token or code id_token
 * token, OIDC Core 1.0 §3.3.1.1) needs on top of the validation of the code
 * flow, and its code with the tokens for a request that needs no screen
 * (prompt=none, or SSO with prior consent).
 */
import {
  completeAuthTransaction,
  isHybridResponseType,
  requireHybridNonce,
  validateHybridResponseMode,
  type AuthorizationRequestParams,
  type AuthTransaction,
  type SessionInfo,
} from '@maronn-openid-connect/core';
import { respondToClient, type AuthorizationResponseMode } from '../../../authorize/response-mode';
import { config, loadSigningKeys, resolvers, stores } from '../../provider';
import { createFragmentResponseMode } from '../implicit-flow/response-mode';
import { issueHybridTokens } from './tokens';

/**
 * ハイブリッドフローに固有の条件を検証する。
 *
 * `response_type` がハイブリッドフローのもの（`code id_token`、`code token`、`code id_token token`）でなければ、何もしない。
 * 検証はトランザクションを作る前に行い、次の条件をそれぞれ core の関数で確かめる。
 * - トークンをクエリに含めないよう、`response_mode=query` を拒否する（OAuth 2.0 Multiple Response Type Encoding Practices §5、§7）。
 * - OP がこのリクエストに使うレスポンスモード（`responseMode`）と異なる `response_mode`（JARM の `query.jwt` や未知の値）も、フラグメントに置き換えずに拒否する。
 * - 認可エンドポイントが ID トークンを返す `code id_token` と `code id_token token` では `nonce` を必須とし、`code token` では認可コードフローと同じく任意とする（OIDC Core 1.0 §3.3.2.11）。
 *
 * 違反には、リダイレクトで返せる `invalid_request` を投げる。
 * ルートハンドラは、このエラーをリクエストのレスポンスモード（既定はフラグメント）でクライアントへ返す（OIDC Core 1.0 §3.3.2.6）。
 *
 * `redirect_uri` と PKCE はここでは検証しない。
 * `redirect_uri` の規則は認可コードフローと同じであり（OIDC Core 1.0 §3.3.2.1 が §3.1.2.1 を参照する）、PKCE のパラメータは `validate-request` のブロックが検証済みだからである。
 *
 * @throws {AuthorizationError} `invalid_request`: 上のどれかの条件に違反するとき。
 * @spec OIDC Core 1.0 §3.3.2.11
 */
export function validateHybridRequest(
  request: { responseType: string; nonce: string | undefined; redirectUri: string; state: string | undefined },
  params: AuthorizationRequestParams,
  responseMode: AuthorizationResponseMode | undefined,
): void {
  if (!isHybridResponseType(request.responseType)) return;
  const { redirectUri, state } = request;

  const requested = (params as { response_mode?: unknown }).response_mode;
  validateHybridResponseMode(
    typeof requested === 'string' ? requested : undefined,
    responseMode === undefined ? [] : [responseMode.name],
    redirectUri,
    state,
  );
  requireHybridNonce(request.responseType, request.nonce, redirectUri, state);
}

/**
 * 認可コードとトークンを発行し、認可レスポンスで返す。
 *
 * 対象は、画面を出さずに応答できるハイブリッドフローのリクエスト（`prompt=none` か、同意済みの SSO）である。
 * ほかのレスポンスタイプには `undefined` を返し、あとのブロック（認可コードの発行）に任せる。
 *
 * トランザクションを終え、そのスコープで認可コードと ID トークンかアクセストークン（または両方）を発行し、グラントを記録する。
 * 認可レスポンスは `responseMode` で返し、ないときはフラグメントで返す（OIDC Core 1.0 §3.3.2.5）。
 * クエリでは返さない。
 *
 * `transaction.scope` は、スコープの方針（`scopes.ts` の `resolveGrantableScopes()`）を通したあとの値である。
 * `offline_access` の方針もリクエストを検証したときに適用済みなので、この認可コードからは、認可コードフローと同じ規則でリフレッシュトークンが発行される。
 *
 * @throws {AuthorizationError} `server_error`: クライアントが登録した `alg` の ID トークンの署名鍵がないとき（`issueHybridTokens()`）。
 * @throws {Error} 署名鍵を読み込めないとき（`loadSigningKeys()`）。
 *   このときトランザクションは終えずに残す。
 */
export async function issueHybridResponse(input: {
  transactionId: string;
  transaction: AuthTransaction;
  session: SessionInfo;
  responseMode: AuthorizationResponseMode | undefined;
}): Promise<Response | undefined> {
  const { transactionId, transaction, session, responseMode } = input;
  if (!isHybridResponseType(transaction.responseType)) return undefined;

  // トランザクションを終える前に、署名鍵を読み込む。
  // 鍵を読み込めないときに、トランザクションを元のまま残すためである。
  const keys = await loadSigningKeys();
  const grantedScope = transaction.scope.split(' ').filter(Boolean);

  // トランザクションは一度しか使えないので、何かを発行する前に終える。
  const responseParams = await completeAuthTransaction(transactionId, transaction, stores.transactionStore);
  const { parameters, grantId } = await issueHybridTokens({
    responseType: transaction.responseType,
    responseParams,
    session,
    grantedScope,
    keys,
  });
  // グラントを記録する。
  // 同意を取り消すと、このグラントのトークン（認可エンドポイントが発行したものと、トークンエンドポイントがこの認可コードに対して発行するもの）が失効する。
  await resolvers.consentResolver.recordGrant(session.subject, transaction.clientId, grantId);

  // リクエストで要求されたレスポンスモード（`form_post` など）で返し、なければフラグメントで返す。
  // トークンをクエリに含めないためである（OAuth 2.0 Multiple Response Type Encoding Practices §5）。
  const mode = responseMode ?? createFragmentResponseMode({ issuer: config.issuer });
  return respondToClient(await mode.respond(transaction.redirectUri, parameters));
}
