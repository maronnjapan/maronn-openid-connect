/**
 * EXPERIMENTAL — RP-Initiated Logout confirmation cookie
 * (RP-Initiated Logout 1.0 §2).
 *
 * Rendering the logout confirmation screen mints a fresh secret and hands it
 * to that one browser twice: in this HttpOnly cookie and in the form's hidden
 * csrf_token. POST /logout/approve runs only when both come back carrying the
 * same secret. An attacker can collect a valid pair in their own browser, but
 * cannot set this cookie in the victim's browser, so a forged cross-site POST
 * fails the comparison (and SameSite=Lax drops the cookie from a cross-site
 * POST to begin with). Neither half alone is ever accepted — the same model
 * as the device verification binding cookie of the device-authorization-grant
 * feature.
 *
 * The cookie also carries the OP-computed post-logout redirect target
 * (base64url of the exact registered URL, or empty when there is none), so
 * the redirect decision survives the confirmation round-trip inside an
 * HttpOnly channel instead of a tamperable hidden form field — and the
 * id_token_hint itself is never echoed into the page.
 */
export const LOGOUT_CONFIRMATION_COOKIE = 'oidc_logout_confirm';

/** What one rendered confirmation screen carries across to its approve POST. */
export interface LogoutConfirmation {
  /** Secret pairing the HttpOnly cookie with the form's hidden csrf_token. */
  csrfSecret: string;
  /** Registered redirect URL resolved at render time, or null for the completed page. */
  redirectTo: string | null;
}

/**
 * ログアウトの確認の `Set-Cookie` の値を組み立てて返す。
 *
 * Cookie の値は、フォームの CSRF 用のシークレットと、確認画面を出すときに決めたリダイレクト先の URL を base64url にしたものを、`.` でつないだものである。
 * リダイレクト先がなければ、`.` のあとを空にする。
 * 属性には `HttpOnly`、`Secure`、`SameSite=Lax`、`Path=/`、`Max-Age=600` を付ける。
 */
export function buildLogoutConfirmationCookie(confirmation: LogoutConfirmation): string {
  const bytes = new TextEncoder().encode(confirmation.redirectTo ?? '');
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  const encodedRedirect = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return (
    LOGOUT_CONFIRMATION_COOKIE + '=' + confirmation.csrfSecret + '.' + encodedRedirect +
    // 有効期間は 10 分にする。
    // 画面を読んでボタンを押すには十分で、確認が放置されても承認待ちの Cookie が長く残らない長さである。
    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600'
  );
}

/**
 * 確認の Cookie を消す `Set-Cookie` の値を返す。
 *
 * `POST /logout/approve` で確認を使い終えたときに付ける。
 * 値を空にし、`Max-Age=0` で期限切れにする。
 */
export function buildClearedLogoutConfirmationCookie(): string {
  return LOGOUT_CONFIRMATION_COOKIE + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

/**
 * 確認の Cookie からシークレットとリダイレクト先を返す。
 *
 * Cookie がないとき、または形式が少しでも崩れているときは `null` を返す。
 * `POST /logout/approve` は `null` を受け取ると、何も削除せずに 400 で応答する。
 * Cookie のリダイレクト先の部分が空なら、`redirectTo` を `null` にして返す。
 */
export function parseLogoutConfirmation(cookieHeader: string | null): LogoutConfirmation | null {
  if (!cookieHeader) return null;
  let value: string | null = null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === LOGOUT_CONFIRMATION_COOKIE) {
      value = trimmed.slice(eq + 1);
      break;
    }
  }
  if (value === null) return null;
  const dot = value.indexOf('.');
  if (dot === -1) return null;
  const csrfSecret = value.slice(0, dot);
  if (csrfSecret === '') return null;
  const encodedRedirect = value.slice(dot + 1);
  if (encodedRedirect === '') return { csrfSecret, redirectTo: null };
  if (!/^[A-Za-z0-9_-]+$/.test(encodedRedirect)) return null;
  try {
    const base64 = encodedRedirect.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return { csrfSecret, redirectTo: new TextDecoder().decode(bytes) };
  } catch {
    return null;
  }
}
