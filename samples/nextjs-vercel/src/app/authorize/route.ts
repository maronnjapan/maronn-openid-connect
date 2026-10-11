/**
 * Authorization Endpoint (OIDC Core 1.0 §3.1.2).
 *
 * The browser's entry into the flow, so every answer is a redirect: back to the
 * client with the authorization response, on to the login or consent screen,
 * or — for an error that must not go back to the client — to the OP's own
 * error page (app/oidc-error).
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  resolveClientForAuthorization,
  validateRegisteredRedirectUris,
  resolveRequestObjectParams,
  validateRequestObjectConsistency,
  resolveAuthorizationRedirectUri,
  rejectUnsupportedRequestParams,
  validateResponseType,
  validateAuthorizationScope,
  validateClientScope,
  validateAuthorizationCodePkce,
  validatePromptParameter,
  applyOfflineAccessPolicy,
  validateDisplayParameter,
  resolveMaxAge,
  parseAudienceParameter,
  parseClaimsRequestParameter,
  validateIdTokenHint,
  createAuthTransaction,
  createAuthorizationCode,
  completeAuthTransaction,
  generateRandomString,
  resolvePromptNoneSession,
  validatePromptNoneIdTokenHint,
  validatePromptNoneConsent,
  requiresReauthentication,
  sanitizeErrorDescription,
  AuthorizationError,
  IdTokenHintError,
  type AuthorizationRequestParams,
} from '@maronn-openid-connect/core';
import {
  clientResolver,
  config,
  idTokenHintJwks,
  loadSigningKeys,
  resolvers,
  stores,
} from '../_oidc-provider/provider';
import {
  isFormUrlEncoded,
  redirectToErrorPage,
  signingKeysUnavailable,
  uniqueParams,
  type UniqueParams,
} from '../_oidc-provider/http';
import { buildTransactionCookie } from '../_oidc-provider/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const { transactionStore, authCodeStore, authSessionStore } = stores;
const { sessionResolver, consentResolver } = resolvers;

/** OIDC Core 1.0 §3.1.2.1: the Authorization Endpoint MUST support GET ... */
export async function GET(request: NextRequest): Promise<Response> {
  return authorize(request, uniqueParams(request.nextUrl.searchParams));
}

/** ... and POST, with a form-encoded body (OIDC Core 1.0 §13.2). */
export async function POST(request: NextRequest): Promise<Response> {
  if (!isFormUrlEncoded(request)) {
    return badRequest('Authorization POST requests must use application/x-www-form-urlencoded');
  }
  return authorize(request, uniqueParams(new URLSearchParams(await request.text())));
}

async function authorize(request: NextRequest, parsed: UniqueParams): Promise<Response> {
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

  // OIDC Core 1.0 §3.1.2.1 / RFC 6749 §3.1: request parameters MUST NOT be repeated.
  if (parsed.duplicateKey !== undefined) {
    return badRequest(`Parameter "${parsed.duplicateKey}" must not be repeated`);
  }

  const rawParams = parsed.params;
  if (!isAuthorizationRequestParams(rawParams)) {
    return badRequest('Missing required parameter: client_id');
  }

  const params = rawParams;
  // RFC 9207 §2: every authorization response (success and error) carries the
  // issuer identifier, so clients can pin the issuer that produced it.
  const issuer = config.issuer;

  try {
    // --- Authorization request validation pipeline ---------------------------
    // Each step below is an independent core function, called in OIDC Core 1.0
    // §3.1.2 order. Delete a call to drop that validation, or insert your own
    // logic between steps. Steps that run before
    // redirectUri is resolved throw non-redirectable errors (shown on the OP);
    // steps after it throw redirectable errors (sent back to the client).

    // OAuth 2.1 §4.1.2.1: resolve client_id into the registered client.
    const client = await resolveClientForAuthorization(params, clientResolver);

    // Fail fast on misconfigured registered redirect URIs (fragments, dangerous
    // schemes, non-loopback http) — OIDC Core 1.0 §3.1.2.1 / RFC 8252 §8.
    validateRegisteredRedirectUris(client.redirectUris);

    // OIDC Core 1.0 §6.1: verify the signed Request Object (request parameter)
    // against the client's registered JWKS and overlay its claims onto the query
    // parameters. RS256 is required; alg=none is accepted only when
    // allowUnsignedRequestObject is enabled (conformance compat).
    // effectiveParams is what every later step validates.
    const { effectiveParams, requestObjectClaims } = await resolveRequestObjectParams(
      params,
      client,
      { allowUnsigned: config.allowUnsignedRequestObject },
    );

    // Resolve redirect_uri against the registered URIs (OIDC Core 1.0 §3.1.2.1).
    const redirectUri = resolveAuthorizationRedirectUri(effectiveParams, client);
    // RFC 6749 §4.1.2.1: state is echoed only on redirectable errors from here on.
    const state = effectiveParams.state;

    // OIDC Core 1.0 §6.3: request_uri / registration are not supported here.
    rejectUnsupportedRequestParams(params, redirectUri, state);

    // OIDC Core 1.0 §6.1: response_type / client_id inside the Request Object
    // must match the OAuth query parameters.
    validateRequestObjectConsistency(params, requestObjectClaims, redirectUri, state);

    // response_type=code and per-client response_type authorization.
    const responseType = validateResponseType(params, client, redirectUri, state);

    // scope must be in the query (OIDC Core 1.0 §6.1) and contain openid (§3.1.2.1).
    let scope = validateAuthorizationScope(params, effectiveParams, redirectUri, state);

    // RFC 7591 §2: a client registered with a scope list (client.scope) may only
    // request those scopes. Any other one, offline_access included, is invalid_scope.
    validateClientScope(scope, client.scope, redirectUri, state);

    // OAuth 2.1 §4.1.1 / §7.5: PKCE with S256 (allowNonPkceAuthorizationCodeFlow
    // exists only for the OIDF Basic OP static-client compatibility target).
    const pkce = validateAuthorizationCodePkce(effectiveParams, client, redirectUri, state, {
      allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow,
    });

    // OIDC Core 1.0 §3.1.2.1: prompt is none|login|consent|select_account.
    const prompt = validatePromptParameter(effectiveParams, redirectUri, state);

    // offline_access は 2 つの独立した条件を両方満たしたときだけ残る。
    // - OIDC Core 1.0 §11: エンドユーザーの同意（prompt=consent）
    // - RFC 7591 §2: クライアント登録の grant_types に refresh_token があること
    //   （既定は ["authorization_code"]）。無いまま offline_access を通すと、発行した
    //   Refresh Token が unauthorized_client で拒否されるだけの死んだ資格情報になる。
    // 独自の許可条件を差し込むならコールバックを渡す（client も受け取れる）:
    //   scope = await applyOfflineAccessPolicy(scope, effectiveParams, prompt, client,
    //     (req, { promptValues }) => promptValues.includes('consent') || hasStoredConsent(req));
    scope = await applyOfflineAccessPolicy(scope, effectiveParams, prompt, client);

    // OIDC Core 1.0 §3.1.2.1: display is page|popup|touch|wap.
    const display = validateDisplayParameter(effectiveParams, redirectUri, state);

    // OIDC Core 1.0 §3.1.2.1 / Dynamic Client Registration 1.0 §2: max_age from
    // the request, falling back to the client's registered default_max_age.
    const maxAge = resolveMaxAge(effectiveParams, client, redirectUri, state);

    // Space-delimited audience for the access token.
    const audience = parseAudienceParameter(effectiveParams);

    // OIDC Core 1.0 §5.5: parse the claims request parameter (userinfo / id_token).
    const claims = parseClaimsRequestParameter(effectiveParams, redirectUri, state);

    // Assemble the validated request from each step's result. This is core's
    // ValidatedAuthorizationRequest (what createAuthTransaction() takes), so
    // transactions and authorization codes are unaffected by adding or removing
    // steps above.
    const validatedRequest = {
      responseType,
      clientId: client.clientId,
      redirectUri,
      // OIDC Core 1.0 §3.1.3.2: when redirect_uri was sent explicitly, the token
      // request must repeat it; remember which case produced this authorization.
      redirectUriExplicit: effectiveParams.redirect_uri !== undefined,
      scope,
      codeChallenge: pkce.codeChallenge,
      codeChallengeMethod: pkce.codeChallengeMethod,
      state,
      nonce: effectiveParams.nonce,
      prompt,
      display,
      maxAge,
      uiLocales: effectiveParams.ui_locales,
      claimsLocales: effectiveParams.claims_locales,
      acrValues: effectiveParams.acr_values,
      loginHint: effectiveParams.login_hint,
      idTokenHint: effectiveParams.id_token_hint,
      audience,
      claims,
    };

    // The authentication transaction carries the request through login and
    // consent. csrfToken is embedded in their forms; transactionId never leaves
    // the OP except in the HttpOnly transaction cookie (buildTransactionCookie()
    // in store.ts).
    const csrfToken = generateRandomString(32);
    const transaction = createAuthTransaction(validatedRequest, csrfToken);
    const transactionId = generateRandomString(32);
    const transactionTtlSeconds = 10 * 60;
    await transactionStore.put('auth_txn:' + transactionId, transaction, transactionTtlSeconds);

    // OIDC Core 1.0 §3.1.2.1: prompt is a space-delimited list.
    const promptValues = transaction.prompt?.trim().split(/\s+/).filter(Boolean) ?? [];

    // prompt=none must not be combined with other values (OIDC Core 1.0 §3.1.2.1).
    if (promptValues.includes('none') && promptValues.length > 1) {
      await transactionStore.delete('auth_txn:' + transactionId);
      return errorRedirect(transaction.redirectUri, 'invalid_request', transaction.state, 'prompt=none must not be combined with other prompt values');
    }

    // OIDC Core 1.0 §3.1.2.1: the id_token_hint rule ("if the End-User identified
    // by the ID Token is logged in ... otherwise it SHOULD return an error") is NOT
    // conditioned on prompt, so the hint is verified here — outside the prompt=none
    // branch — and therefore on every prompt path. Verification covers signature,
    // iss, aud, exp and iat; the verified subject is shared by the prompt=none
    // check and the SSO fast path below, so an unverified hint never reaches a
    // session decision.
    let verifiedHintSubject: string | undefined;
    if (transaction.idTokenHint !== undefined) {
      try {
        const verified = await validateIdTokenHint(transaction.idTokenHint, {
          expectedIss: issuer,
          expectedAud: transaction.clientId,
          jwks: await idTokenHintJwks(keys),
        });
        verifiedHintSubject = verified.sub;
      } catch (hintError) {
        await transactionStore.delete('auth_txn:' + transactionId);
        const code = hintError instanceof IdTokenHintError ? hintError.error : 'login_required';
        return errorRedirect(transaction.redirectUri, code, transaction.state, hintError instanceof Error && hintError.message ? hintError.message : 'id_token_hint verification failed');
      }
    }

    // prompt=none: silent authentication without any user interaction
    // (OIDC Core 1.0 §3.1.2.1).
    if (promptValues.includes('none')) {
      let session;
      try {
        // --- prompt=none pipeline -------------------------------------------
        // Each step below is an independent core function: the session, then
        // id_token_hint (before consent, so consent is never looked up for
        // another End-User), then consent. Every step throws
        // AuthorizationError(login_required | consent_required) on failure.

        // OIDC Core 1.0 §3.1.2.1: no active session → login_required (the OP
        // must not show a login screen for prompt=none).
        session = await resolvePromptNoneSession(transaction, sessionResolver, request);

        // verifiedHintSubject は上流（prompt 非依存の検証ブロック）で確定済み。
        // ここでは prompt=none 固有の「不一致なら login_required」判定だけを行う。
        // コンセント確認より前に置くのは、コンセント検索が session.subject をキーに
        // するため — 不一致のまま進むと別ユーザーのコンセントを見てしまう。
        validatePromptNoneIdTokenHint(transaction, session, verifiedHintSubject);

        // OIDC Core 1.0 §3.1.2.1: not consented → consent_required (the OP must
        // not show a consent screen for prompt=none).
        await validatePromptNoneConsent(transaction, session, consentResolver);
      } catch (promptError) {
        await transactionStore.delete('auth_txn:' + transactionId);
        if (promptError instanceof AuthorizationError) {
          return errorRedirect(transaction.redirectUri, promptError.error, transaction.state, promptError.errorDescription);
        }
        const serverDescription =
          promptError instanceof Error && promptError.message
            ? promptError.message
            : 'Unexpected error while evaluating prompt=none';
        return errorRedirect(transaction.redirectUri, 'server_error', transaction.state, serverDescription);
      }

      // OIDC Core 1.0 §3.1.2.1: a session older than max_age cannot be refreshed
      // without interaction, which prompt=none forbids.
      if (transaction.maxAge !== undefined && requiresReauthentication(transaction.maxAge, session.authTime)) {
        await transactionStore.delete('auth_txn:' + transactionId);
        return errorRedirect(transaction.redirectUri, 'login_required', transaction.state, 'Session exceeds the requested max_age; re-authentication required');
      }

      // transaction.scope は認可リクエスト検証時に applyOfflineAccessPolicy を通した
      // 後の値。offline_access の可否（OIDC Core 1.0 §11 の prompt=consent と、
      // クライアント登録 grant_types に refresh_token があるか）はそこで判定済みなので、
      // ここで再フィルタしない。
      const grantedScope = transaction.scope.split(' ').filter(Boolean);

      const responseParams = await completeAuthTransaction(
        transactionId,
        transaction,
        transactionStore,
      );
      const authCodeData = await createAuthorizationCode({
        authorizationResponse: { ...responseParams, scope: grantedScope },
        subject: session.subject,
        authTime: session.authTime,
        // online refresh token をこのログインセッションへ束縛するために引き継ぐ。
        // セッションが終われば、その RT は invalid_grant になる。
        sessionId: session.sessionId,
        // OIDC Core 1.0 §3.1.3.1: TTL は ProviderConfig から設定可能（既定 300 秒）。
        ttlSeconds: config.authorizationCodeTtl,
      });
      await authCodeStore.set(authCodeData.code, authCodeData);
      await consentResolver.recordGrant(session.subject, transaction.clientId, authCodeData.grantId);

      return successRedirect(transaction.redirectUri, authCodeData.code, transaction.state);
    }

    // OIDC Core 1.0 §3.1.2.3: an active OP session enables Single Sign-On, so it
    // is reused (skipping the login screen) unless prompt forces fresh
    // authentication. With max_age the session must also be fresh enough
    // (§3.1.2.1). prompt=login / prompt=select_account always re-authenticate.
    if (!promptValues.includes('login') && !promptValues.includes('select_account')) {
      const existingSession = await sessionResolver.resolve(request);
      const sessionIsFresh =
        existingSession !== null &&
        (transaction.maxAge === undefined ||
          !requiresReauthentication(transaction.maxAge, existingSession.authTime));
      // OIDC Core 1.0 §3.1.2.1: id_token_hint が指す End-User でなければ既存
      // セッションを再利用しない。これが無いと「セッションは User B / hint は
      // User A」の要求に対し B の認可コードを黙って発行してしまう。
      // 不一致はエラーにせずログイン画面へ落とし、正しい End-User として認証さ
      // せる（login_required を即返すかは方針判断に委ねる）。
      const hintMatchesSession =
        verifiedHintSubject === undefined ||
        (existingSession !== null && verifiedHintSubject === existingSession.subject);
      if (existingSession && sessionIsFresh && hintMatchesSession) {
        // OIDC Core 1.0 §3.1.2.1: prompt=consent MUST re-display the consent UI.
        // Otherwise, when the End-User already granted (a superset of) the
        // requested scopes to this client, the code is issued right away — the
        // interactive analogue of the prompt=none path.
        const consentAlreadyGranted =
          !promptValues.includes('consent') &&
          (await consentResolver.hasConsent(
            existingSession.subject,
            transaction.clientId,
            transaction.scope.split(' ').filter(Boolean),
          ));

        if (consentAlreadyGranted) {
          // transaction.scope は applyOfflineAccessPolicy 通過後の値（prompt=consent と
          // クライアントの grant_types で offline_access の可否は判定済み）。再フィルタしない。
          const grantedScope = transaction.scope.split(' ').filter(Boolean);

          const responseParams = await completeAuthTransaction(
            transactionId,
            transaction,
            transactionStore,
          );
          const authCodeData = await createAuthorizationCode({
            authorizationResponse: { ...responseParams, scope: grantedScope },
            subject: existingSession.subject,
            authTime: existingSession.authTime,
            // online refresh token を、この SSO で再利用したログインセッションへ束縛する。
            sessionId: existingSession.sessionId,
            // OIDC Core 1.0 §3.1.3.1: TTL は ProviderConfig から設定可能（既定 300 秒）。
            ttlSeconds: config.authorizationCodeTtl,
          });
          await authCodeStore.set(authCodeData.code, authCodeData);
          await consentResolver.recordGrant(
            existingSession.subject,
            transaction.clientId,
            authCodeData.grantId,
          );

          return successRedirect(transaction.redirectUri, authCodeData.code, transaction.state);
        }

        // Signed in already: hand the subject to the consent step.
        await authSessionStore.set(transactionId, {
          subject: existingSession.subject,
          authTime: existingSession.authTime,
          // consent 画面を経由しても online refresh token の束縛先を見失わないよう、
          // login → consent の受け渡しに sessionId も載せる。
          sessionId: existingSession.sessionId,
        });
        return redirectToScreen('/consent', transactionId, transactionTtlSeconds);
      }
    }

    // Interactive authentication (prompt=login forces it even with a session).
    return redirectToScreen('/login', transactionId, transactionTtlSeconds);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.redirectUri) {
        return errorRedirect(error.redirectUri, error.error, error.state, error.errorDescription);
      }
      // OIDC Core 1.0 §3.1.2.2: an error that cannot be redirected (unknown
      // client_id, unregistered redirect_uri, redirect_uri with a fragment) MUST
      // NOT go to the supplied redirect_uri.
      return nonRedirectableError(request, error.error, error.errorDescription);
    }
    return Response.json({ error: 'server_error' }, { status: 500 });
  }
}

/**
 * Narrows raw parameters to AuthorizationRequestParams. PKCE parameters are
 * validated by core, so conformance compatibility mode can pass requests that
 * omit them.
 */
function isAuthorizationRequestParams(params: unknown): params is AuthorizationRequestParams {
  if (typeof params !== 'object' || params === null) return false;
  return typeof (params as Record<string, unknown>)['client_id'] === 'string';
}

/** Malformed transport: OAuth error JSON, there is no transaction to show a screen for. */
function badRequest(errorDescription: string): Response {
  return Response.json({ error: 'invalid_request', error_description: errorDescription }, { status: 400 });
}

/**
 * Continue on one of the OP's own screens. The URL carries no query: the
 * transaction goes to the browser only in the HttpOnly transaction cookie, so
 * it never shows up in history, logs or a shared screen, and the page finds it
 * there (requireTransaction() in _oidc-provider/transaction.ts).
 *
 * The URL is built on config.issuer, never on the request URL: some platforms
 * derive the request URL from the Host header, which would let the sender
 * choose the redirect origin (OIDC Discovery 1.0 §3 / RFC 9700 §2.1).
 */
function redirectToScreen(
  path: '/login' | '/consent',
  transactionId: string,
  ttlSeconds: number,
): Response {
  const response = NextResponse.redirect(new URL(path, config.issuer), 302);
  response.headers.append('Set-Cookie', buildTransactionCookie(transactionId, ttlSeconds));
  return response;
}

/**
 * OIDC Core 1.0 §3.1.2.2: an error that cannot be sent back to the client stays
 * on the OP. Programmatic callers asking for JSON get the OAuth error JSON;
 * browsers are sent to the OP's error page (app/oidc-error/page.tsx), which the
 * OIDF Conformance Suite screenshots for oidcc-ensure-registered-redirect-uri.
 */
function nonRedirectableError(request: Request, error: string, errorDescription?: string): Response {
  if ((request.headers.get('Accept') ?? '').includes('application/json')) {
    return Response.json({ error, error_description: errorDescription }, { status: 400 });
  }
  return redirectToErrorPage(error, errorDescription);
}

/**
 * A redirectable error (OIDC Core 1.0 §3.1.2.6 / RFC 6749 §4.1.2.1), with iss
 * (RFC 9207 §2). error_description is reduced to the RFC 6749 §5.2 character
 * set, so a user-controlled fragment cannot smuggle control bytes into the URL.
 */
function errorRedirect(
  redirectUri: string,
  error: string,
  state?: string,
  errorDescription?: string,
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (errorDescription) {
    url.searchParams.set('error_description', sanitizeErrorDescription(errorDescription));
  }
  if (state) url.searchParams.set('state', state);
  url.searchParams.set('iss', config.issuer);
  return NextResponse.redirect(url, 302);
}

/** The authorization response carrying the code (OIDC Core 1.0 §3.1.2.5), with iss (RFC 9207 §2). */
function successRedirect(redirectUri: string, code: string, state: string | undefined): Response {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  url.searchParams.set('iss', config.issuer);
  return NextResponse.redirect(url, 302);
}
