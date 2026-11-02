/**
 * EXPERIMENTAL — CIBA login transaction binding cookie (CIBA Core 1.0; the
 * authentication device UI itself is outside the spec's scope, §7.1).
 *
 * Why this exists: a successful login on /ciba/login establishes an OP session,
 * whose reach goes beyond CIBA (SSO, prompt=none). A hidden csrf_token alone
 * cannot stop login CSRF: the attacker fetches their own /ciba login form,
 * reads a valid login_transaction_id + csrf_token pair, and embeds both in a
 * forged cross-site POST — planting the attacker's session in the victim's
 * browser. What stops it is this cookie: the login form response binds the
 * transaction to the browser that requested it by handing that one browser the
 * raw bindingSecret in an HttpOnly cookie while the transaction stores only its
 * SHA-256 hash. A forged POST cannot carry the victim's cookie (SameSite=Lax),
 * and the victim never held this transaction's cookie anyway.
 *
 * The cookie name embeds the transaction id so two login forms can run in the
 * same browser without overwriting each other's secret.
 */
export const CIBA_LOGIN_BINDING_COOKIE_PREFIX = 'oidc_ciba_login_';

/**
 * バインディング Cookie の `Set-Cookie` の値を返す。
 *
 * この Cookie で、CIBA のログイントランザクションをこのブラウザに結び付ける。
 * 名前は `oidc_ciba_login_<transactionId>` で、値には `bindingSecret` をそのまま入れる。
 * 属性はセッションの Cookie と同じ `HttpOnly`（JavaScript から読めない）、`Secure`（HTTPS でだけ送られる）、`SameSite=Lax` である。
 * ブラウザは `http://localhost` を安全な接続として扱うので、`Secure` を付けても手元の `http://localhost` で使える。
 * `Max-Age` には `ttlSeconds` を入れる。
 * 呼び出し側はトランザクションの残りの有効期間を渡すので、ログインフォームを放置しても Cookie がいつまでも残ることはない。
 */
export function buildCibaLoginBindingCookie(
  transactionId: string,
  bindingSecret: string,
  ttlSeconds: number,
): string {
  return (
    CIBA_LOGIN_BINDING_COOKIE_PREFIX + transactionId + '=' + bindingSecret +
    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + String(ttlSeconds)
  );
}

/**
 * バインディング Cookie を消す `Set-Cookie` の値を返す。
 *
 * 名前と属性は {@link buildCibaLoginBindingCookie} と同じにし、値を空に、`Max-Age` を 0 にする。
 * ログインに成功した後に使い、ログインフォームを開くたびに Cookie がブラウザにたまっていくのを防ぐ。
 */
export function buildClearedCibaLoginBindingCookie(transactionId: string): string {
  return (
    CIBA_LOGIN_BINDING_COOKIE_PREFIX + transactionId +
    '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  );
}

/**
 * バインディング Cookie の値を取り出して返す。
 *
 * `cookieHeader`（`Cookie` ヘッダーの値）から、名前が `oidc_ciba_login_<transactionId>` の Cookie を探して、その値を返す。
 * ヘッダーがないときと、その Cookie がないときは `null` を返す。
 * `validateCibaLoginSubmission()` は、`null` を受け取ると 403 で拒否する。
 */
export function parseCibaLoginBindingSecret(
  cookieHeader: string | null,
  transactionId: string,
): string | null {
  if (!cookieHeader) return null;
  const name = CIBA_LOGIN_BINDING_COOKIE_PREFIX + transactionId;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}
