/**
 * EXPERIMENTAL — device verification binding cookie (RFC 8628 §5.4 / §3.3).
 *
 * Why this exists: the user_code is, by design, known to whoever started the
 * device flow — and that party can be the attacker. A CSRF token that hangs off
 * the record is therefore worthless on its own: the attacker POSTs /device with
 * their own code, reads the token, and can then forge `POST /device/approve`
 * (consent coercion: the victim's tokens land on the attacker's device) or
 * `POST /device/login` (login CSRF: the victim's browser gets the attacker's
 * OP session). Neither is stopped by keeping the token secret.
 *
 * The binding is what stops them. On a successful user_code match the OP mints a
 * bindingSecret, hands the raw value to that one browser in an HttpOnly cookie,
 * and stores only its SHA-256 hash on the record. /device/login and
 * /device/approve refuse to run unless the presented cookie hashes to the stored
 * value, so a forged cross-site POST — which cannot carry the victim's cookie
 * (SameSite=Lax), and whose victim never held this record's cookie anyway — is
 * rejected without relying on any secret staying secret.
 *
 * The authorize flow does not need this: its transaction id never leaves the
 * OP except in the HttpOnly transaction cookie, so the cookie itself is the
 * binding. Here the identifier is public to the attacker by construction, so a
 * separate secret has to be handed out once the code matches. Like the authorize
 * flow, driving the verification UI by hand with curl needs a cookie jar
 * (-c / -b).
 *
 * The cookie name embeds the normalized user_code so two device flows can run in
 * the same browser without overwriting each other's secret.
 */
export const DEVICE_BINDING_COOKIE_PREFIX = 'oidc_device_';

/**
 * Build the Set-Cookie value binding one device verification to this browser.
 * Same attributes as the session cookie: HttpOnly (no JS access), Secure (HTTPS
 * only; http://localhost is treated as trustworthy by browsers) and
 * SameSite=Lax. Max-Age matches the remaining record TTL so an abandoned
 * verification does not leave a cookie behind.
 */
export function buildDeviceBindingCookie(
  userCode: string,
  bindingSecret: string,
  ttlSeconds: number,
): string {
  return (
    DEVICE_BINDING_COOKIE_PREFIX + userCode + '=' + bindingSecret +
    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + String(ttlSeconds)
  );
}

/**
 * Build the Set-Cookie value that clears the binding cookie once the user has
 * approved or denied, so the browser does not accumulate one cookie per flow.
 */
export function buildClearedDeviceBindingCookie(userCode: string): string {
  return (
    DEVICE_BINDING_COOKIE_PREFIX + userCode +
    '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  );
}

/**
 * Extract the binding secret for one device verification from a Cookie header.
 * Returns null when the header is missing or this record's cookie is absent,
 * which validateVerificationBinding() rejects with 403.
 */
export function parseDeviceBindingSecret(
  cookieHeader: string | null,
  userCode: string,
): string | null {
  if (!cookieHeader) return null;
  const name = DEVICE_BINDING_COOKIE_PREFIX + userCode;
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
