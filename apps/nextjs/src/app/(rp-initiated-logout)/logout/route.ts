/**
 * EXPERIMENTAL — end_session_endpoint (OpenID Connect RP-Initiated Logout 1.0).
 *
 * Generated because the OP was created with `--enable rp-initiated-logout`.
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may change in a
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
} from '@maronn-openid-connect/experimental/rp-initiated-logout';
import { IdTokenHintError, generateRandomString, validateIdTokenHint } from '@maronn-openid-connect/core';
import { readFormFields } from '../../_oidc-provider/http';
import {
  config,
  idTokenHintJwks,
  loadSigningKeys,
  stores,
} from '../../_oidc-provider/provider';
import { buildClearedSessionCookie, parseSessionId } from '../../_oidc-provider/cookies';
import { buildLogoutConfirmationCookie } from '../../_oidc-provider/features/rp-initiated-logout/cookies';
import { rpInitiatedLogoutConfig } from '../../_oidc-provider/features/rp-initiated-logout/config';
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
