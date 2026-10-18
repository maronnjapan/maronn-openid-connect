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
 * Build the Set-Cookie value binding one CIBA login transaction to this
 * browser. Same attributes as the session cookie: HttpOnly (no JS access),
 * Secure (HTTPS only; http://localhost is treated as trustworthy by browsers)
 * and SameSite=Lax. Max-Age matches the transaction TTL so an abandoned login
 * form does not leave a cookie behind.
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
 * Build the Set-Cookie value that clears the binding cookie once the login
 * succeeded, so the browser does not accumulate one cookie per login form.
 */
export function buildClearedCibaLoginBindingCookie(transactionId: string): string {
  return (
    CIBA_LOGIN_BINDING_COOKIE_PREFIX + transactionId +
    '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  );
}

/**
 * Extract the binding secret for one CIBA login transaction from a Cookie
 * header. Returns null when the header is missing or this transaction's cookie
 * is absent, which validateCibaLoginSubmission() rejects with 403.
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
