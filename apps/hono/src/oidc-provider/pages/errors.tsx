/** @jsxImportSource hono/jsx */
/**
 * Error screen (screen routing layer).
 *
 * Whenever a page has to stop the browser on the OP's own error page it calls
 * renderErrorPage() here. Customize the error UI in views.tsx (errorPage), or
 * change how it is delivered in this file — for example by redirecting to a
 * page of your own.
 */
import { defaultViews, renderView, type ErrorPageParams, type Views } from '../views.js';

/**
 * OP のエラー画面の HTML で応答する。
 *
 * ビューの `errorPage` に `params` を渡して描画する。
 * `params.statusCode` は、レスポンスのステータスコードであり、ビューが受け取る値でもある。
 * そのため、独自のビューでもステータスコードを表示でき、ステータスコードと表示する内容が食い違わない（ロックアウトの画面は 429、ブラウザのバインディングを確かめられなかった画面は 403 で応答する）。
 */
export function renderErrorPage(c: any, params: ErrorPageParams): Response {
  const views: Views = c.get('views') ?? defaultViews;
  return renderView(<views.errorPage {...params} />, { status: params.statusCode });
}

/**
 * リダイレクトできない認可エラーを 400 の画面で返す。
 *
 * 登録されていない `client_id`、登録されていない `redirect_uri`、フラグメントを含む `redirect_uri` では、OP が信頼してよいリダイレクト先がない。
 * そのため、エラーはクライアントへリダイレクトせず、OP の画面に表示しなければならない（RFC 6749 §4.1.2.1 の MUST）。
 * `renderErrorPage()` で、エラーのビューを 400 の HTML のレスポンスにして返す。
 *
 * @spec OIDC Core 1.0 §3.1.2.2
 */
export function renderAuthorizationErrorPage(
  c: any,
  params: { error: string; errorDescription?: string },
): Response {
  return renderErrorPage(c, {
    error: params.error,
    errorDescription: params.errorDescription,
    statusCode: 400,
  });
}
