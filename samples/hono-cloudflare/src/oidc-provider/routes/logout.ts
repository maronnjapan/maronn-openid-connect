/**
 * EXPERIMENTAL — OpenID Connect RP-Initiated Logout 1.0, end_session_endpoint
 * — API layer: logic only.
 *
 * This module was generated because the OP was created with
 * `--enable rp-initiated-logout`. It is backed by
 * @maronn-openid-connect/experimental, whose API is NOT stable: it may change in a breaking
 * way between releases. Do not build production code on it without pinning the
 * version.
 *
 * The RP sends the user agent to /logout (GET or POST, §2 MUST) to end the OP
 * browser session. A request whose id_token_hint verifies against this OP's
 * keys AND matches the current session's End-User logs out immediately; every
 * other request — no hint, an invalid or expired hint, a client_id that
 * mismatches the hint audience, no session, another user's session — falls to
 * one shared confirmation screen (§2 MUST; §7: an unauthenticated logout link
 * would otherwise be a denial-of-service primitive). The failure reason is
 * never disclosed anywhere: a reason would turn this endpoint into an oracle
 * for session state.
 *
 * Neither function below builds a Response: each returns an outcome (which
 * screen or redirect comes next, with which cookies), and pages/logout.tsx —
 * which owns the GET and POST routes — turns it into HTTP.
 *
 * ## Why the confirmation approve step demands a cookie + token pair
 *
 * The approve POST ends a session, so a forged cross-site POST must not drive
 * it. When the confirmation screen is shown the OP mints a fresh secret and
 * hands it to that one browser twice: in an HttpOnly cookie and in the form's
 * hidden csrf_token. approveLogout() runs only when both come back equal. An
 * attacker can obtain a valid pair in their own browser but cannot plant that
 * cookie into the victim's, so the forged POST fails the comparison — the
 * same model as the device verification binding cookie (see store.ts).
 *
 * The cookie also carries the OP-computed post-logout redirect target, so the
 * confirmation flow never round-trips the id_token_hint (or any redirect
 * parameter) through the HTML page: the only value the form submits back is
 * the csrf_token itself.
 */
import {
  decideLogoutFlow,
  extractIdTokenHintAudience,
  parseEndSessionRequest,
  resolvePostLogoutRedirect,
} from '@maronn-openid-connect/experimental/rp-initiated-logout';
import { IdTokenHintError, generateRandomString, validateIdTokenHint } from '@maronn-openid-connect/core';
import {
  browserSessionStore as defaultBrowserSessionStore,
  buildClearedLogoutConfirmationCookie,
  buildClearedSessionCookie,
  buildLogoutConfirmationCookie,
  parseLogoutConfirmation,
  parseSessionId,
} from '../store.js';
import { defaultProviderConfig } from '../config.js';

/**
 * EXPERIMENTAL — settings for RP-Initiated Logout.
 *
 * postLogoutRedirectUris is the registry §3 checks against: client_id → the
 * exact post_logout_redirect_uri values that client registered (a registry of
 * its own — the authorize redirect_uris are NOT reused). A requested URI is
 * used only on an exact string match for the client the id_token_hint
 * verified for; everything else falls back to the completed page
 * (fail-closed). The default is empty, so no logout redirect happens until
 * you register one here.
 */
export const rpInitiatedLogoutConfig = {
  postLogoutRedirectUris: {} as Record<string, string[]>,
};

/** What a logout step decided; pages/logout.tsx turns it into HTTP. */
export type LogoutOutcome =
  /** Forged, replayed or expired confirmation: nothing was deleted (400). */
  | { kind: 'invalid_confirmation' }
  /** §2 MUST: ask first. cookies pairs the HttpOnly secret with the form's csrf_token. */
  | { kind: 'confirmation'; csrfToken: string; cookies: string[] }
  /** Logged out; §3: return to the registered post_logout_redirect_uri (state appended). */
  | { kind: 'redirect'; location: string; cookies: string[] }
  /** Logged out; no registered redirect applied, so show the completed screen. */
  | { kind: 'completed'; cookies: string[] };

/**
 * Interpret one end_session request (§2). GET and POST share this function —
 * they differ only in where the parameters come from.
 */
export async function processEndSessionRequest(c: any, params: URLSearchParams): Promise<LogoutOutcome> {
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const config = c.get('config') ?? defaultProviderConfig;
  const request = parseEndSessionRequest(params);
  // logout_hint and ui_locales are accepted but unused (OPTIONAL, §2): the
  // hint is not read past parsing and is never logged — it can identify the
  // End-User. The same goes for the id_token_hint value itself.

  // §2: verify the hint (signature / iss / aud / exp) against the same key
  // set id_token_hint uses elsewhere (context jwksProvider). The expected
  // audience is the client_id parameter when present, otherwise it is
  // extracted — unverified — from the hint payload; trust comes from
  // validateIdTokenHint afterwards.
  let verifiedHint: { sub: string; [key: string]: unknown } | null = null;
  let expectedAudience: string | null = null;
  if (request.idTokenHint !== undefined) {
    expectedAudience = request.clientId ?? extractIdTokenHintAudience(request.idTokenHint);
    if (expectedAudience !== null) {
      try {
        const jwks = await c.get('jwksProvider')();
        verifiedHint = await validateIdTokenHint(request.idTokenHint, {
          expectedIss: config.issuer,
          expectedAud: expectedAudience,
          jwks,
        });
      } catch (error) {
        // An expired, tampered or foreign hint is not an error to report — it
        // just fails to prove logout authority, so the request falls to the
        // confirmation path (§2 MUST) with no reason disclosed. Anything that
        // is not a hint-validation failure (e.g. the JWKS provider itself
        // failing) is rethrown: masking an outage as "invalid hint" would
        // silently degrade every logout into a confirmation.
        if (!(error instanceof IdTokenHintError)) throw error;
        verifiedHint = null;
      }
    }
  }

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;

  const decision = decideLogoutFlow({
    verifiedHint,
    expectedAudience,
    clientIdParam: request.clientId,
    sessionSubject: session ? session.subject : null,
  });

  // §3: redirect only to the verified client's exactly-matching registered
  // URI, with state appended. Resolved before the branch because the
  // confirmation flow honors the same result after approval — the redirect
  // condition is the hint and the exact match, not which path the logout took.
  const redirectTo = resolvePostLogoutRedirect({
    postLogoutRedirectUri: request.postLogoutRedirectUri,
    state: request.state,
    verifiedClientId: decision.verifiedClientId,
    registeredUris:
      decision.verifiedClientId === null
        ? []
        : rpInitiatedLogoutConfig.postLogoutRedirectUris[decision.verifiedClientId] ?? [],
  });

  if (decision.requiresConfirmation) {
    // §2 MUST. Nothing is deleted here, and the screen's wording never varies
    // with session state. The minted secret pairs the HttpOnly cookie with the
    // form's hidden csrf_token; the redirect target rides inside the cookie.
    const csrfSecret = generateRandomString(32);
    return {
      kind: 'confirmation',
      csrfToken: csrfSecret,
      cookies: [buildLogoutConfirmationCookie({ csrfSecret, redirectTo })],
    };
  }

  // Immediate logout: a valid hint for the current session's End-User (§2).
  // Delete the store entry and expire the cookie together.
  if (sessionId) {
    await browserSessionStore.delete(sessionId);
  }
  const cookies = [buildClearedSessionCookie()];
  if (redirectTo !== null) {
    return { kind: 'redirect', location: redirectTo, cookies };
  }
  return { kind: 'completed', cookies };
}

/**
 * Confirmation approve (POST /logout/approve)
 *
 * Runs only for the browser that saw the confirmation screen: the HttpOnly
 * cookie and the hidden csrf_token must present the same secret (neither
 * alone is accepted). On success the session is deleted and the redirect
 * decision computed when the screen was shown — carried in the cookie, never
 * in the form — is honored (§3).
 */
export async function approveLogout(c: any, csrfToken: string): Promise<LogoutOutcome> {
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;

  const confirmation = parseLogoutConfirmation(c.req.header('Cookie') ?? null);
  if (confirmation === null || csrfToken === '' || confirmation.csrfSecret !== csrfToken) {
    // Forged, replayed or expired confirmation: delete nothing.
    return { kind: 'invalid_confirmation' };
  }

  // The End-User explicitly approved (§2). When the session is already gone
  // there is nothing to delete and the answer is the same either way — the
  // confirmation flow is not an oracle for whether a session existed.
  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  if (sessionId) {
    await browserSessionStore.delete(sessionId);
  }
  const cookies = [buildClearedSessionCookie(), buildClearedLogoutConfirmationCookie()];
  if (confirmation.redirectTo !== null) {
    return { kind: 'redirect', location: confirmation.redirectTo, cookies };
  }
  return { kind: 'completed', cookies };
}
