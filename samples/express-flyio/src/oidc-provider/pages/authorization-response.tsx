/** @jsxImportSource hono/jsx */
/**
 * Authorization response (screen routing layer).
 *
 * /authorize and /consent end in the authorization response for the client,
 * in the response mode the request asked for (endpoints/authorize/
 * response-mode.ts): a redirect whose URL carries it, or an HTML form the
 * browser posts to the redirect URI. respondToClient() turns either into HTTP.
 * Customize the form page in views.tsx (formPostPage).
 */
import type { AuthorizationResponse } from '../endpoints/authorize/response-mode.js';
import { defaultViews, renderView, type Views } from '../views.js';
import { redirectWithCookies, withCookies } from './respond.js';

/**
 * 認可レスポンスで応答し、指定の Cookie を設定する。
 *
 * レスポンスモードがリダイレクト（`method: 'redirect'`）なら、認可レスポンスのパラメータを含む `location` へ 302 でリダイレクトする。
 * フォームで送るモード（`method: 'form_post'`）なら、ビューの `formPostPage` で、ブラウザがパラメータをリダイレクト URI へ POST するフォームの HTML を返す。
 * どちらの場合も、`cookies` の値ごとに `Set-Cookie` ヘッダーを付ける。
 */
export function respondToClient(
  c: any,
  response: AuthorizationResponse,
  cookies: readonly string[] = [],
): Response {
  if (response.method === 'redirect') {
    return redirectWithCookies(response.location, cookies);
  }
  const views: Views = c.get('views') ?? defaultViews;
  // フォームの HTML を、保存を禁じるヘッダーを付けて描画する。
  // この応答は一度しか使わないので、ブラウザも中継サーバーも保存や再利用をしてはならない（OAuth 2.0 Form Post Response Mode §2 の MUST NOT）。
  // ヘッダーは同じ仕様の付録 A のものに合わせる。
  const page = renderView(<views.formPostPage action={response.action} fields={response.fields} />, {
    headers: { 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
  });
  return withCookies(page, cookies);
}
