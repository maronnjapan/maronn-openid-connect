/**
 * The cookies of the provider and the origin check of its forms.
 *
 * - session_id: the browser (OP) session, OIDC Core 1.0 Section 3.1.2.3. It
 *   lasts across authorization requests and is what makes SSO, prompt=none
 *   and max_age work.
 * - __Host-oidc_txn: the authorization transaction this browser is in the
 *   middle of (Section 3.1.2.3 / 3.1.2.4).
 */
export const SESSION_COOKIE_NAME = 'session_id';

/**
 * `Cookie` ヘッダーの `session_id` の値を返す。
 *
 * ヘッダーがないとき、または `session_id` の Cookie がないときは `undefined` を返す。
 * 値が空の `session_id` には空文字列を返す。
 */
export function parseSessionId(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === SESSION_COOKIE_NAME) {
      return trimmed.slice(eq + 1);
    }
  }
  return undefined;
}

/**
 * ブラウザセッションの `Set-Cookie` の値を作って返す。
 *
 * 属性は `HttpOnly`（JavaScript から読めない）、`Secure`（HTTPS でだけ送る）、`SameSite=Lax`、`Path=/` である。
 * `SameSite=Strict` にしないのは、`Strict` ではほかのサイトから認可エンドポイントへ移るリダイレクトでブラウザが Cookie を送らず、フローが途中で止まるからである。
 */
export function buildSessionCookie(sessionId: string): string {
  return SESSION_COOKIE_NAME + '=' + sessionId + '; HttpOnly; Secure; SameSite=Lax; Path=/';
}

/**
 * The browser's current authorization transaction (OIDC Core 1.0 §3.1.2.3 / §3.1.2.4).
 *
 * /authorize puts the random ID in this HttpOnly cookie and the screen URL.
 * Login and consent require the cookie and URL to match before showing a form.
 * POSTs also require the hidden transaction_id to match, then check the stored
 * csrf_token before authenticating, recording a decision or issuing a code.
 * Knowing a URL or copying its form never substitutes for the matching cookie.
 *
 * A second /authorize replaces the browser's cookie, so older tabs are refused.
 * The __Host- prefix requires Secure, Path=/ and no Domain, preventing a sibling
 * subdomain from setting this cookie. Keep those attributes when customizing it.
 */
export const TRANSACTION_COOKIE_NAME = '__Host-oidc_txn';

/**
 * トランザクションの `Set-Cookie` の値を作って返す。
 *
 * ブラウザにトランザクションを渡すときに使う。
 * 属性は、セッションの Cookie と同じ `HttpOnly`（JavaScript から読めない）、`Secure`（HTTPS でだけ送る）、`SameSite=Lax`、`Path=/` に、`Max-Age` を加えたものである。
 * ブラウザは `http://localhost` を信頼できるオリジンとして扱うので、`Secure` の Cookie も手元の開発環境で使える。
 * `SameSite=Strict` にしないのは、`Strict` ではフローを始めるほかのサイトからの遷移でブラウザが Cookie を送らなくなるからである。
 * `Secure` と `Path=/` を付けて `Domain` を付けないのは、`__Host-` の接頭辞の要件でもある。
 * `Max-Age` をトランザクションの有効期間（`ttlSeconds`）に合わせるので、途中でやめたフローの Cookie は残らない。
 */
export function buildTransactionCookie(transactionId: string, ttlSeconds: number): string {
  return (
    TRANSACTION_COOKIE_NAME + '=' + transactionId +
    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + String(ttlSeconds)
  );
}

/**
 * トランザクションの Cookie を消す `Set-Cookie` を返す。
 *
 * トランザクションが終わったとき（認可コードを発行したとき、またはアクセスが拒否されたとき）に使う。
 * 値を空にして `Max-Age=0` を付けるので、ブラウザは Cookie を削除する。
 * ブラウザは `Secure` と `Path=/` のない `__Host-` の Cookie の書き込みを、削除も含めて無視するので、この二つも付ける。
 */
export function buildClearedTransactionCookie(): string {
  return TRANSACTION_COOKIE_NAME + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

/**
 * `Cookie` ヘッダーのトランザクション ID を返す。
 *
 * トランザクション ID は `__Host-oidc_txn` の Cookie の値である。
 * ヘッダーがないとき、その Cookie がないとき、値が空のときは `undefined` を返す。
 */
export function parseTransactionId(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === TRANSACTION_COOKIE_NAME) {
      return trimmed.slice(eq + 1) || undefined;
    }
  }
  return undefined;
}

/**
 * OP 自身のページから送られた POST なら true を返す。
 *
 * `/login` と `/consent` へのフォームの POST を確かめるのに使う。
 * この検査は、トランザクションの Cookie にも `csrf_token` にもよらない。
 * リクエストの送り元はブラウザ自身がヘッダーで示し、ページのスクリプトはそのヘッダーを書き換えられないからである。
 * そのため、同じ親ドメインの別のサブドメインがトランザクションの Cookie を仕込み、その `csrf_token` を知っている場合でも、この検査で拒否できる。
 * 同じサイト（同じ親ドメインの別のサブドメイン）からの POST には `SameSite=Lax` が働かないので、それを拒否できるのはこの検査だけである。
 *
 * 判定は次のとおりである。
 * - `Sec-Fetch-Site` ヘッダー（フェッチメタデータ）があれば、`same-origin` と `none` のときだけ `true` を返す。
 *   `none` は再読み込みのようにユーザー自身が始めたリクエストで、ほかのサイトからは起こせない。
 *   `same-site`（同じ親ドメインの別のサブドメイン）と `cross-site` には `false` を返す。
 * - `Sec-Fetch-Site` がなければ、ブラウザがどの POST にも付ける `Origin` ヘッダーが、発行者のオリジンと一致するときだけ `true` を返す。
 *   `Origin` が `null`（不透明なオリジン）なら一致しない。
 * - どちらのヘッダーもなければ `true` を返す。
 *   ブラウザのページ以外（`curl` や HTTP クライアント）か、とても古いブラウザからのリクエストであり、トランザクションの Cookie と `csrf_token` の検証は引き続き行われる。
 *
 * 比較には設定の `issuer` を使い、リクエストの URL は使わない。
 * 実行環境によってはリクエストの URL を `Host` ヘッダーから求めるので、送り手がその値を変えられるからである。
 */
export function isSameOriginFormPost(
  headers: { origin: string | null; secFetchSite: string | null },
  issuer: string,
): boolean {
  if (headers.secFetchSite !== null) {
    return headers.secFetchSite === 'same-origin' || headers.secFetchSite === 'none';
  }
  if (headers.origin !== null) {
    return headers.origin === new URL(issuer).origin;
  }
  return true;
}

/** The message the OP shows when isSameOriginFormPost() refuses a form POST. */
export const CROSS_ORIGIN_FORM_POST_MESSAGE =
  'This form can only be submitted from the authorization server itself.';

/**
 * セッションの Cookie を消す `Set-Cookie` を返す。
 *
 * 値を空にして `Max-Age=0` を付けるので、ブラウザは Cookie を削除する。
 * ログアウトのルートは、これと `browserSessionStore.delete()` を組にして使い、ストアのセッションと Cookie を一緒に消す（RP-Initiated Logout 1.0 §2）。
 */
export function buildClearedSessionCookie(): string {
  return SESSION_COOKIE_NAME + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}
