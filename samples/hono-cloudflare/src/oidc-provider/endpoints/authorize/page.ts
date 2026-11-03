/**
 * Authorization endpoint (screen routing layer).
 *
 * GET|POST /authorize is the browser's entry into the flow, and every answer it
 * gives is a redirect or a screen: back to the client with the authorization
 * response (a redirect, or the form a form_post response is posted from), on
 * to /login or /consent, or the OP's own error page. Deciding
 * WHICH of those applies — the whole OIDC Core 1.0 §3.1.2 validation pipeline,
 * SSO, prompt=none — is processAuthorizationRequest() in pipeline.ts; this
 * file only turns its outcome into HTTP.
 */
import { Hono } from 'hono';
import { respondToClient } from '../../pages/authorization-response.js';
import { renderAuthorizationErrorPage } from '../../pages/errors.js';
import { redirectWithCookies } from '../../pages/respond.js';
import type { AuthorizationOutcome } from './outcome.js';
import { processAuthorizationRequest } from './pipeline.js';

export const authorizePage = new Hono<{ Variables: Record<string, any> }>();

/**
 * OP の画面（`/login` か `/consent`）の URL を返す。
 *
 * URL にはクエリを付けない。
 * トランザクション ID は、結果に入っているトランザクションの Cookie（`cookies.ts` の `buildTransactionCookie()`）だけでブラウザに渡すので、閲覧履歴、ログ、共有した画面に出ることはない。
 *
 * URL はリクエストの URL ではなく `config.issuer` から作る。
 * 実行環境によってはリクエストの URL を `Host` ヘッダーから求めるので、リクエストの URL から作ると、送信者がリダイレクト先のオリジンを選べてしまう（RFC 9700 §2.1 は、信頼できる URI にだけリダイレクトするよう求めている）。
 * OP 自身を指す URL は、公開している `issuer` を基準にする（OIDC Discovery 1.0 §3）。
 * 画面のパスは絶対パスなので、`issuer` がパスを含んでいても、使うのはそのオリジンだけである。
 * そのため、生成されたルートは、オリジンの下のパスに組み込む構成に対応していない。
 */
function screenUrl(c: any, path: '/login' | '/consent'): string {
  const config = c.get('config');
  return new URL(path, config.issuer).toString();
}

/**
 * パイプラインの結果を HTTP レスポンスにして返す。
 *
 * 結果の種類（`outcome.kind`）ごとに、次のように応答する。
 * - `bad_request`: 400 の JSON で OAuth のエラーレスポンスを返す。
 * - `authorization_response`: 認可レスポンスでクライアントに応答する（302 のリダイレクトか、`form_post` のフォーム）。
 * - `login` と `consent`: 結果に入っているトランザクションの Cookie を付けて、ログイン画面か同意画面へ 302 でリダイレクトする。
 * - `error`: `Accept` ヘッダーが `application/json` を含めば 400 の JSON で、そうでなければ OP のエラー画面（400 の HTML）で応答する。
 * - それ以外（`server_error`）: 500 の JSON で `server_error` を返す。
 */
function respond(c: any, outcome: AuthorizationOutcome): Response {
  if (outcome.kind === 'bad_request') {
    // リクエストの形式の誤り（`POST` の `Content-Type` の誤り、パラメータの重複、`client_id` の欠落）には、400 の JSON で OAuth のエラーレスポンスを返す。
    // まだトランザクションが無く、画面に表示するものが無いためである。
    return c.json({ error: outcome.error, error_description: outcome.errorDescription }, 400);
  }
  if (outcome.kind === 'authorization_response') {
    // 認可コードかリダイレクトできるエラーを、リクエストが求めたレスポンスモードでクライアントへ返す。
    return respondToClient(c, outcome.response);
  }
  if (outcome.kind === 'login') {
    return redirectWithCookies(screenUrl(c, '/login'), outcome.cookies);
  }
  if (outcome.kind === 'consent') {
    return redirectWithCookies(screenUrl(c, '/consent'), outcome.cookies);
  }
  if (outcome.kind === 'error') {
    // リダイレクトできないエラー（未知の `client_id`、登録されていない `redirect_uri`、フラグメントを含む `redirect_uri`、対応するリクエストが見つからない `request_uri`）は、クライアントへ返さず OP で応答する（OIDC Core 1.0 §3.1.2.2）。
    // `Accept` ヘッダーで JSON を求めるプログラムの呼び出し元には 400 の JSON で OAuth のエラーレスポンスを返し、ブラウザには OP のエラー画面を返す。
    // OIDF の適合性テストの `oidcc-ensure-registered-redirect-uri` は、このエラー画面のスクリーンショットを撮る。
    const acceptsJson = (c.req.header('Accept') ?? '').includes('application/json');
    if (acceptsJson) {
      return c.json({ error: outcome.error, error_description: outcome.errorDescription }, 400);
    }
    return renderAuthorizationErrorPage(c, outcome);
  }
  return c.json({ error: 'server_error' }, 500);
}

const handleAuthorizationRequest = async (c: any): Promise<Response> =>
  respond(c, await processAuthorizationRequest(c));

// OIDC Core 1.0 Section 3.1.2.1: Authorization Endpoint must support both GET and POST.
authorizePage.get('/', handleAuthorizationRequest);
authorizePage.post('/', handleAuthorizationRequest);
