/**
 * Next.js templates for experimental OpenID Connect RP-Initiated Logout 1.0:
 * the end_session_endpoint and its confirmation screen.
 * Only generated with `--enable rp-initiated-logout`.
 */
import { EXPERIMENTAL_PACKAGE } from '../hono/templates.js';

const LOGOUT_PACKAGE = `${EXPERIMENTAL_PACKAGE}/rp-initiated-logout`;

/** `logout/config.ts` — the post_logout_redirect_uri registry. */
export function nextJsLogoutConfigTemplate(): string {
  return `/**
 * EXPERIMENTAL — RP-Initiated Logout settings.
 *
 * postLogoutRedirectUris is the registry §3 checks against: client_id → the
 * exact post_logout_redirect_uri values that client registered (a registry of
 * its own — the authorize redirect_uris are NOT reused). A requested URI is used
 * only on an exact string match for the client the id_token_hint verified for;
 * everything else falls back to the logged-out screen (fail-closed). The
 * default is empty, so no logout redirect happens until you register one here.
 */
export const rpInitiatedLogoutConfig = {
  postLogoutRedirectUris: {} as Record<string, string[]>,
};
`;
}

/** `logout/screens.ts` — the confirmation and logged-out screens. */
export function nextJsLogoutScreensTemplate(): string {
  return `/**
 * EXPERIMENTAL — the RP-Initiated Logout screens (RP-Initiated Logout 1.0 §2).
 *
 * Restyle the UI here. The confirmation form must keep posting csrf_token to
 * /logout/approve: it is paired with the HttpOnly cookie the end_session
 * endpoint mints.
 */
import { escapeHtml, htmlResponse } from '../_oidc-provider/html';

/**
 * The logout confirmation screen (§2 MUST when no valid id_token_hint is
 * presented). The wording is the same on every path into it — no hint, an
 * invalid or expired hint, another user's session, no session at all — so the
 * page is no oracle for session state or for why the hint failed.
 */
export function confirmationScreen(csrfToken: string, cookies: readonly string[]): Response {
  return htmlResponse(
    \`<!DOCTYPE html>
<html>
<head><title>Log out</title></head>
<body>
  <h1>Log out</h1>
  <p>Do you want to log out of the OpenID Provider?</p>
  <p>If you did not request this, close this page.</p>
  <form method="POST" action="/logout/approve">
    <input type="hidden" name="csrf_token" value="\${escapeHtml(csrfToken)}" />
    <button type="submit">Log out</button>
  </form>
</body>
</html>\`,
    { cookies },
  );
}

/**
 * The logged-out screen. It shows no End-User or client identifier, and its
 * wording never depends on whether anything was actually deleted — varying it
 * would make the page a session-existence oracle.
 */
export function completedScreen(cookies: readonly string[]): Response {
  return htmlResponse(
    \`<!DOCTYPE html>
<html>
<head><title>Logged out</title></head>
<body>
  <h1>Logged out</h1>
  <p>You have been logged out.</p>
  <p>You can close this page.</p>
</body>
</html>\`,
    { cookies },
  );
}
`;
}

/** `logout/route.ts` — the end_session_endpoint (GET and POST, §2). */
export function nextJsLogoutRouteTemplate(corePkg: string): string {
  return `/**
 * EXPERIMENTAL — end_session_endpoint (OpenID Connect RP-Initiated Logout 1.0).
 *
 * Generated because the OP was created with \`--enable rp-initiated-logout\`.
 * Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may change in a
 * breaking way between releases. Do not build production code on it without
 * pinning the version.
 *
 * The RP sends the user agent here (GET or POST, §2 MUST) to end the OP browser
 * session. A request whose id_token_hint verifies against this OP's keys AND
 * matches the current session's End-User logs out immediately; every other
 * request — no hint, an invalid or expired hint, a client_id that mismatches the
 * hint audience, no session, another user's session — falls to one shared
 * confirmation screen (§2 MUST; §7: an unauthenticated logout link would
 * otherwise be a denial-of-service primitive). The failure reason is never
 * disclosed: it would turn this endpoint into an oracle for session state.
 *
 * ## Why the confirmation needs a cookie + token pair
 *
 * Approving the confirmation ends a session, so a forged cross-site POST must
 * not drive it. The confirmation screen hands this browser a fresh secret
 * twice: in an HttpOnly cookie and in the form's hidden csrf_token, and
 * /logout/approve runs only when both come back equal. The cookie also carries
 * the OP-computed post-logout redirect, so the id_token_hint is never
 * round-tripped through the HTML page.
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  decideLogoutFlow,
  extractIdTokenHintAudience,
  parseEndSessionRequest,
  resolvePostLogoutRedirect,
} from '${LOGOUT_PACKAGE}';
import { IdTokenHintError, generateRandomString, validateIdTokenHint } from '${corePkg}';
import { readFormFields } from '../_oidc-provider/html';
import { config, idTokenHintJwks, loadSigningKeys, stores } from '../_oidc-provider/provider';
import {
  buildClearedSessionCookie,
  buildLogoutConfirmationCookie,
  parseSessionId,
} from '../_oidc-provider/store';
import { rpInitiatedLogoutConfig } from './config';
import { completedScreen, confirmationScreen } from './screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<Response> {
  return endSession(request, request.nextUrl.searchParams);
}

/** §2: POST carries the same parameters in an application/x-www-form-urlencoded body. */
export async function POST(request: Request): Promise<Response> {
  const params = new URLSearchParams();
  for (const [name, value] of await readFormFields(request)) {
    if (typeof value === 'string') params.append(name, value);
  }
  return endSession(request, params);
}

async function endSession(request: Request, params: URLSearchParams): Promise<Response> {
  const endSessionRequest = parseEndSessionRequest(params);
  // logout_hint and ui_locales are accepted but unused (OPTIONAL, §2). The hint
  // is never logged — it can identify the End-User — and neither is the
  // id_token_hint value itself.

  // §2: verify the hint (signature / iss / aud / exp) against the keys
  // id_token_hint is verified with elsewhere. The expected audience is the
  // client_id parameter when present, otherwise it is read — unverified — from
  // the hint payload; trust comes from validateIdTokenHint afterwards.
  let verifiedHint: { sub: string; [key: string]: unknown } | null = null;
  let expectedAudience: string | null = null;
  if (endSessionRequest.idTokenHint !== undefined) {
    expectedAudience =
      endSessionRequest.clientId ?? extractIdTokenHintAudience(endSessionRequest.idTokenHint);
    if (expectedAudience !== null) {
      try {
        verifiedHint = await validateIdTokenHint(endSessionRequest.idTokenHint, {
          expectedIss: config.issuer,
          expectedAud: expectedAudience,
          jwks: await idTokenHintJwks(await loadSigningKeys()),
        });
      } catch (error) {
        // An expired, tampered or foreign hint just fails to prove logout
        // authority, so the request falls to the confirmation path (§2 MUST)
        // with no reason disclosed. Anything else (the keys failing to load)
        // is rethrown: masking an outage as "invalid hint" would silently turn
        // every logout into a confirmation.
        if (!(error instanceof IdTokenHintError)) throw error;
        verifiedHint = null;
      }
    }
  }

  const sessionId = parseSessionId(request.headers.get('Cookie'));
  const session = sessionId ? await stores.browserSessionStore.get(sessionId) : undefined;

  const decision = decideLogoutFlow({
    verifiedHint,
    expectedAudience,
    clientIdParam: endSessionRequest.clientId,
    sessionSubject: session ? session.subject : null,
  });

  // §3: redirect only to the verified client's exactly-matching registered URI,
  // with state appended. Resolved before the branch because the confirmation
  // flow honors the same result after approval.
  const redirectTo = resolvePostLogoutRedirect({
    postLogoutRedirectUri: endSessionRequest.postLogoutRedirectUri,
    state: endSessionRequest.state,
    verifiedClientId: decision.verifiedClientId,
    registeredUris:
      decision.verifiedClientId === null
        ? []
        : rpInitiatedLogoutConfig.postLogoutRedirectUris[decision.verifiedClientId] ?? [],
  });

  if (decision.requiresConfirmation) {
    // §2 MUST: ask first. Nothing is deleted yet. The minted secret pairs the
    // HttpOnly cookie with the form's hidden csrf_token; the redirect target
    // rides inside the cookie.
    const csrfSecret = generateRandomString(32);
    return confirmationScreen(csrfSecret, [buildLogoutConfirmationCookie({ csrfSecret, redirectTo })]);
  }

  // Immediate logout: a valid hint for the current session's End-User (§2).
  // Delete the store entry and expire the cookie together.
  if (sessionId) {
    await stores.browserSessionStore.delete(sessionId);
  }
  const cookies = [buildClearedSessionCookie()];
  if (redirectTo !== null) {
    const response = NextResponse.redirect(redirectTo, 302);
    for (const cookie of cookies) response.headers.append('Set-Cookie', cookie);
    return response;
  }
  return completedScreen(cookies);
}
`;
}

/** `logout/approve/route.ts` — the confirmation form's submission. */
export function nextJsLogoutApproveRouteTemplate(): string {
  return `/**
 * EXPERIMENTAL — RP-Initiated Logout confirmation approve.
 *
 * Runs only for the browser that saw the confirmation screen: the HttpOnly
 * cookie and the hidden csrf_token must present the same secret (neither alone
 * is accepted). On success the session is deleted and the redirect decided when
 * the screen was shown — carried in the cookie, never in the form — is honored
 * (§3).
 *
 * Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable.
 */
import { NextResponse } from 'next/server';
import { errorPage, readFormFields } from '../../_oidc-provider/html';
import { stores } from '../../_oidc-provider/provider';
import {
  buildClearedLogoutConfirmationCookie,
  buildClearedSessionCookie,
  parseLogoutConfirmation,
  parseSessionId,
} from '../../_oidc-provider/store';
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
`;
}
