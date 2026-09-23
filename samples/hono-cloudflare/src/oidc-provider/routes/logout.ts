/**
 * EXPERIMENTAL — OpenID Connect RP-Initiated Logout 1.0, end_session_endpoint.
 *
 * This route was generated because the OP was created with
 * `--enable rp-initiated-logout`. It is backed by
 * @maronn-openid-connect/experimental, whose API is NOT stable: it may change in a breaking
 * way between releases. Do not build production code on it without pinning the
 * version.
 *
 * The RP sends the user agent here (GET or POST, §2 MUST) to end the OP
 * browser session. A request whose id_token_hint verifies against this OP's
 * keys AND matches the current session's End-User logs out immediately; every
 * other request — no hint, an invalid or expired hint, a client_id that
 * mismatches the hint audience, no session, another user's session — falls to
 * one shared confirmation screen (§2 MUST; §7: an unauthenticated logout link
 * would otherwise be a denial-of-service primitive). The failure reason is
 * never disclosed anywhere: a reason would turn this endpoint into an oracle
 * for session state.
 *
 * ## Why the confirmation approve step demands a cookie + token pair
 *
 * The approve POST ends a session, so a forged cross-site POST must not drive
 * it. When the confirmation screen is rendered the OP mints a fresh secret and
 * hands it to that one browser twice: in an HttpOnly cookie and in the form's
 * hidden csrf_token. /logout/approve runs only when both come back equal. An
 * attacker can obtain a valid pair in their own browser but cannot plant that
 * cookie into the victim's, so the forged POST fails the comparison — the
 * same model as the device verification binding cookie (see store.ts).
 *
 * The cookie also carries the OP-computed post-logout redirect target, so the
 * confirmation flow never round-trips the id_token_hint (or any redirect
 * parameter) through the HTML page: the only value the form submits back is
 * the csrf_token itself.
 */
import { Hono } from 'hono';
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
import { defaultViews, renderView } from '../views.js';

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

export const logoutApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * Attach Set-Cookie headers to a Response a view already produced.
 * renderView() builds its own Response, so headers staged on the framework
 * context never reach it (same helper as the device verification UI).
 */
function withCookies(response: Response, cookies: string[]): Response {
  const headers = new Headers(response.headers);
  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** 302 to the registered post_logout_redirect_uri, with cookies attached. */
function redirectResponse(location: string, cookies: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(null, { status: 302, headers });
}

/**
 * Interpret one end_session request (§2) and answer it. GET and POST share
 * this handler — they differ only in where the parameters come from.
 */
async function handleEndSessionRequest(c: any, params: URLSearchParams): Promise<Response> {
  const views = c.get('views') ?? defaultViews;
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
    return withCookies(
      renderView(views.logoutConfirmationPage({ csrfToken: csrfSecret })),
      [buildLogoutConfirmationCookie({ csrfSecret, redirectTo })],
    );
  }

  // Immediate logout: a valid hint for the current session's End-User (§2).
  // Delete the store entry and expire the cookie together.
  if (sessionId) {
    await browserSessionStore.delete(sessionId);
  }
  const cookies = [buildClearedSessionCookie()];
  if (redirectTo !== null) {
    return redirectResponse(redirectTo, cookies);
  }
  return withCookies(renderView(views.logoutCompletedPage({})), cookies);
}

/** end_session_endpoint - GET (§2: the OP MUST support GET and POST). */
logoutApp.get('/', (c) => handleEndSessionRequest(c, new URL(c.req.url).searchParams));

/** end_session_endpoint - POST, application/x-www-form-urlencoded body (§2). */
logoutApp.post('/', async (c) => {
  const body = await c.req.parseBody();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') {
      params.append(key, value);
    }
  }
  return handleEndSessionRequest(c, params);
});

/**
 * Confirmation approve - POST
 *
 * Runs only for the browser that rendered the confirmation screen: the
 * HttpOnly cookie and the hidden csrf_token must present the same secret
 * (neither alone is accepted). On success the session is deleted and the
 * redirect decision computed at render time — carried in the cookie, never in
 * the form — is honored (§3).
 */
logoutApp.post('/approve', async (c) => {
  const views = c.get('views') ?? defaultViews;
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;

  const body = await c.req.parseBody();
  const csrfToken = String(body['csrf_token'] ?? '');
  const confirmation = parseLogoutConfirmation(c.req.header('Cookie') ?? null);
  if (confirmation === null || csrfToken === '' || confirmation.csrfSecret !== csrfToken) {
    // Forged, replayed or expired confirmation: delete nothing. This is a
    // browser surface, so the answer is the error page, not OAuth error JSON.
    return renderView(
      views.errorPage({ error: 'Invalid logout confirmation', statusCode: 400 }),
      { status: 400 },
    );
  }

  // The End-User explicitly approved (§2). When the session is already gone
  // there is nothing to delete and the response is the same either way — the
  // confirmation flow is not an oracle for whether a session existed.
  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  if (sessionId) {
    await browserSessionStore.delete(sessionId);
  }
  const cookies = [buildClearedSessionCookie(), buildClearedLogoutConfirmationCookie()];
  if (confirmation.redirectTo !== null) {
    return redirectResponse(confirmation.redirectTo, cookies);
  }
  return withCookies(renderView(views.logoutCompletedPage({})), cookies);
});
