/**
 * Starting the OP browser session once the End-User is authenticated — shared
 * by every login method (the password form's Server Action and the Google
 * callback in login/google/route.ts).
 */
import { cookies } from 'next/headers';
import { generateRandomString, type AuthTransaction } from '@maronn-openid-connect/core';
import { stores } from '../_oidc-provider/provider';
import { SESSION_COOKIE_NAME } from '../_oidc-provider/store';

/**
 * Start the OP session for subject and hand it to the consent step of this
 * transaction.
 *
 * The session (OIDC Core 1.0 §3.1.2.3) is what SSO, prompt=none and max_age
 * read back on later authorization requests: an opaque id in an HttpOnly
 * cookie, with the same attributes as buildSessionCookie() in store.ts —
 * Secure, and SameSite=Lax because Strict would drop it on the cross-site
 * redirect back from the client.
 */
export async function startSession(
  transactionId: string,
  transaction: AuthTransaction,
  subject: string,
): Promise<void> {
  const cookieStore = await cookies();

  // prompt=login / select_account require fresh authentication: discard any
  // existing hand-off for this transaction AND the browser's current session
  // (OIDC Core 1.0 §3.1.2.1 — prompt is a space-delimited list).
  const promptValues = transaction.prompt?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (promptValues.includes('login') || promptValues.includes('select_account')) {
    await stores.authSessionStore.delete(transactionId);
    const existingSessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    if (existingSessionId) await stores.browserSessionStore.delete(existingSessionId);
  }

  const authTime = Math.floor(Date.now() / 1000);
  const sessionId = generateRandomString(32);
  await stores.browserSessionStore.set(sessionId, { subject, authTime });

  // The per-transaction hand-off to the consent step. sessionId も渡すのは online
  // refresh token のため。consent 経由で発行する認可コードにこのセッションを引き継ぎ、
  // ログアウトで使えなくなる RT を作る。
  await stores.authSessionStore.set(transactionId, { subject, authTime, sessionId });

  cookieStore.set(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  });
}
