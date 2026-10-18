/**
 * EXPERIMENTAL — RP-Initiated Logout confirmation approve.
 *
 * Runs only for the browser that saw the confirmation screen: the HttpOnly
 * cookie and the hidden csrf_token must present the same secret (neither alone
 * is accepted). On success the session is deleted and the redirect decided when
 * the screen was shown — carried in the cookie, never in the form — is honored
 * (§3).
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import { NextResponse } from 'next/server';
import { errorPage } from '../../../_oidc-provider/html';
import { readFormFields } from '../../../_oidc-provider/http';
import { stores } from '../../../_oidc-provider/provider';
import { buildClearedLogoutConfirmationCookie, parseLogoutConfirmation } from '../../../_oidc-provider/features/rp-initiated-logout/cookies';
import { buildClearedSessionCookie, parseSessionId } from '../../../_oidc-provider/cookies';
import { completedScreen } from '../screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const csrfToken = String((await readFormFields(request)).get('csrf_token') ?? '');
  const cookieHeader = request.headers.get('Cookie');

  const confirmation = parseLogoutConfirmation(cookieHeader);
  if (confirmation === null || csrfToken === '' || confirmation.csrfSecret !== csrfToken) {
    // Forged, replayed or expired confirmation: nothing is deleted. This is a
    // browser surface, so the answer is the error page, not OAuth error JSON.
    return errorPage('Invalid logout confirmation', 400);
  }

  // The End-User explicitly approved (§2). When the session is already gone
  // there is nothing to delete and the answer is the same either way — the
  // confirmation flow is no oracle for whether a session existed.
  const sessionId = parseSessionId(cookieHeader);
  if (sessionId) {
    await stores.browserSessionStore.delete(sessionId);
  }
  const cookies = [buildClearedSessionCookie(), buildClearedLogoutConfirmationCookie()];
  if (confirmation.redirectTo !== null) {
    const response = NextResponse.redirect(confirmation.redirectTo, 302);
    for (const cookie of cookies) response.headers.append('Set-Cookie', cookie);
    return response;
  }
  return completedScreen(cookies);
}
