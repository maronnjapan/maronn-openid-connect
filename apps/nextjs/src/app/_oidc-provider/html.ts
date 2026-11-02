/**
 * HTML responses for the screens that are served by Route Handlers instead of
 * React pages: the device verification UI, the CIBA authentication device UI,
 * the RP-Initiated Logout screens and the form of a form_post authorization
 * response.
 *
 * Those screens set a cookie on the very response that renders them (a browser
 * binding, or a confirmation secret), and their failures carry a status code
 * (403, 429, ...) that the security model and its tests rely on. A Server
 * Component can do neither, and Next.js does not render React from a Route
 * Handler, so these stay plain HTML responses. Every other screen of the OP is
 * a React page (login, consent, oidc-error).
 */

/**
 * 値を HTML のテキストと属性値に入れられる形にして返す。
 *
 * `&`、`<`、`>`、`"`、`'` を文字参照に置き換えるので、二重引用符で囲んだ属性値にも入れられる。
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * HTML のレスポンスを返し、指定の Cookie を設定する。
 *
 * ステータスコードは `init.status`（既定は 200）である。
 * ヘッダーは、既定の `Content-Type: text/html; charset=UTF-8` と `Cache-Control: no-store` を、`init.headers` で上書きしたものである。
 * `init.cookies` の値ごとに、`Set-Cookie` ヘッダーを一つ付ける。
 * Cookie は、画面を描画したステップが決めたものである。
 *
 * どの画面も、このブラウザの Cookie が指す束縛かセッションに合わせて描画するが、URL はそのどちらも示さない。
 * 保存された写しがあると、あるブラウザの `csrf_token` を、別のブラウザやあとのフローに見せてしまう。
 * そのため既定では、ブラウザにも中継サーバーにもページを保存させない（RFC 9111 §5.2.2.5）。
 * キャッシュの扱いが違う画面は、`init.headers` で自分の `Cache-Control` を渡す。
 * React のページ（ログイン、同意、`oidc-error`）はレスポンスのヘッダーを設定できないので、`next.config.mjs` の `headers()` で同じ `no-store` を付ける。
 */
export function htmlResponse(
  html: string,
  init: { status?: number; cookies?: readonly string[]; headers?: HeadersInit } = {},
): Response {
  const headers = new Headers({ 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' });
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  for (const cookie of init.cookies ?? []) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(html, { status: init.status ?? 200, headers });
}

/**
 * OP のエラー画面の HTML で応答する。
 *
 * 画面には、`error` と、あれば `errorDescription` を、エスケープしてから表示する。
 * `statusCode` はレスポンスのステータスコードにだけ使うので、画面とレスポンスが別の結果を示すことはない（ロックアウトの画面は 429、ブラウザの束縛に失敗した画面は 403 で応答する）。
 */
export function errorPage(error: string, statusCode: number, errorDescription?: string): Response {
  const descriptionHtml = errorDescription ? `  <p>${escapeHtml(errorDescription)}</p>\n` : '';
  return htmlResponse(
    `<!DOCTYPE html>
<html>
<head><title>Error</title></head>
<body>
  <h1>Error</h1>
  <p>${escapeHtml(error)}</p>
${descriptionHtml}</body>
</html>`,
    { status: statusCode },
  );
}

/**
 * 認可レスポンスを自動で POST するフォームで応答する。
 *
 * フォームの `action` はクライアントのリダイレクト URI、メソッドは POST で、パラメータごとに隠しフィールドを一つ置く。
 * スクリプトは、読み込まれるとすぐにフォームを送信する（仕様の付録 A は `body` の `onload` で同じことをする）。
 * JavaScript が動かないブラウザでは、`noscript` の中のボタンで送信できる。
 * この応答は一度しか使わないので、付録 A のヘッダー（`Cache-Control: no-cache, no-store` と `Pragma: no-cache`）で、ブラウザにも中継サーバーにも保存させない。
 *
 * @spec OAuth 2.0 Form Post Response Mode §2
 */
export function formPostPage(action: string, fields: Readonly<Record<string, string>>): Response {
  const inputs = Object.entries(fields)
    .map(([name, value]) => `    <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}"/>\n`)
    .join('');
  return htmlResponse(
    `<!DOCTYPE html>
<html>
<head><title>Submit This Form</title></head>
<body>
  <form method="post" action="${escapeHtml(action)}">
${inputs}    <noscript><button type="submit">Continue</button></noscript>
  </form>
  <script>document.forms[0].submit();</script>
</body>
</html>`,
    { headers: { 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' } },
  );
}
