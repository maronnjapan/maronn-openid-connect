/**
 * Response helpers shared by the screens (the page.tsx of the endpoints and
 * features).
 *
 * The steps of a screen describe what to do (which screen to show, where to
 * send the browser, which cookies to set) as an outcome and never build a
 * Response. The helpers below are how a page turns that outcome into HTTP.
 */

/**
 * レスポンスに `Set-Cookie` ヘッダーを足して返す。
 *
 * `cookies` の値ごとに `Set-Cookie` ヘッダーを一つ加え、ボディ、ステータス、ほかのヘッダーはそのままの新しいレスポンスを作って返す。
 * `cookies` が空なら、受け取ったレスポンスをそのまま返す。
 *
 * `renderView()` は自分でレスポンスを作るので、フレームワークのコンテキストに設定したヘッダーはそのレスポンスに入らない。
 * レスポンスを作り直せば、ビューに Cookie を扱わせずに、フレームワークによらない方法で Cookie を付けられる。
 */
export function withCookies(response: Response, cookies: readonly string[]): Response {
  if (cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * `location` へリダイレクトし、Cookie を設定する。
 *
 * ステータスコードは `status` で、渡さなければ 302 である。
 * `cookies` の値ごとに `Set-Cookie` ヘッダーを一つ付け、ボディは空にする。
 */
export function redirectWithCookies(
  location: string,
  cookies: readonly string[] = [],
  status = 302,
): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(null, { status, headers });
}
