/**
 * Authorization Endpoint (OIDC Core 1.0 §3.1.2).
 *
 * The browser's entry into the flow, so every answer is a redirect or a page:
 * back to the client with the authorization response (a redirect, or the form
 * a form_post response is posted from), on to the login or consent screen,
 * or — for an error that must not go back to the client — to the OP's own
 * error page (app/oidc-error).
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  resolveClientForAuthorization,
  validateRegisteredRedirectUris,
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
  validateAcrValuesParameter,
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
  AuthorizationErrorCode,
  IdTokenHintError,
  responseTypeIncludes,
  type AuthorizationRequestParams,
  type AuthTransaction,
  type SessionInfo,
} from '@maronn-openid-connect/core';
import { resolveFormPostResponseContext } from '../_oidc-provider/features/form-post-response-mode/authorize';
import {
  issueImplicitResponse,
  resolveFragmentResponseContext,
  validateImplicitRequest,
} from '../_oidc-provider/features/implicit-flow/authorize';
import { resolveJarmResponseContext } from '../_oidc-provider/features/jarm/authorize';
import { resolvePushedAuthorizationRequest } from '../_oidc-provider/features/par/authorize';
import { resolveRequestObject } from '../_oidc-provider/features/request-object/authorize';
import { responseTypesOf, tokenGrantsOf } from '../_oidc-provider/feature';
import { features } from '../_oidc-provider/features';
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
import { buildTransactionCookie } from '../_oidc-provider/cookies';
import { findUnsupportedScopes, resolveGrantableScopes } from '../_oidc-provider/scopes';
import {
  authorizationResponseOf,
  respondToClient,
  type AuthorizationResponseMode,
  type ResponseModeTransaction,
} from './response-mode';

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
  // [load-signing-keys] Load the signing keys — OIDC Core 1.0 §10.1
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

  // [parse-request] Parse the authorization request — OIDC Core 1.0 §3.1.2.1 / RFC 6749 §3.1
  // Request parameters MUST NOT be repeated.
  if (parsed.duplicateKey !== undefined) {
    return badRequest(`Parameter "${parsed.duplicateKey}" must not be repeated`);
  }
  if (!isAuthorizationRequestParams(parsed.params)) {
    return badRequest('Missing required parameter: client_id');
  }
  let params: Record<string, string> & AuthorizationRequestParams = parsed.params;

  // The response mode the request asked for, when a feature answers in one
  // (JARM, form_post, the fragment of the Implicit Flow). Set once
  // redirect_uri is verified, by the first block of a feature that answers
  // the request's response_mode or response_type (each assigns it only while
  // it is still unset); undefined means the plain query response. Declared
  // before the try block so the catch can answer in the mode the request
  // asked for.
  let responseMode: AuthorizationResponseMode | undefined;
  // RFC 9207 §2: every authorization response (success and error) carries the
  // issuer identifier, so clients can pin the issuer that produced it.
  const issuer = config.issuer;

  // Each step below is an independent core function, called in OIDC Core 1.0
  // §3.1.2 order. Delete a call to drop that validation, or insert your own
  // logic between steps. Steps that run before redirectUri is resolved throw
  // non-redirectable errors (shown on the OP); steps after it throw
  // redirectable errors (sent back to the client).
  try {
    // [resolve-pushed-request] (feature: par) Expand the pushed request_uri — RFC 9126 §4 / §5
    params = await resolvePushedAuthorizationRequest(params);

    // [resolve-client] Resolve the client — OAuth 2.1 §4.1.2.1 / RFC 8252 §8
    const client = await resolveClientForAuthorization(params, clientResolver);
    // Fail fast on misconfigured registered redirect URIs (fragments, dangerous
    // schemes, non-loopback http) — OIDC Core 1.0 §3.1.2.1 / RFC 8252 §8.
    validateRegisteredRedirectUris(client.redirectUris);

    // [resolve-request-object] (feature: request-object) Verify the Request Object and overlay its claims — OIDC Core 1.0 §6.1
    const { effectiveParams, requestObjectClaims } = await resolveRequestObject(params, client);

    // [resolve-redirect-uri] Resolve redirect_uri (errors become redirectable) — OIDC Core 1.0 §3.1.2.1 / RFC 6749 §4.1.2.1
    // The parameters every later step validates: the Request Object's claims
    // over the query, or the query as it is.
    const requestParams = effectiveParams ?? params;
    const redirectUri = resolveAuthorizationRedirectUri(requestParams, client);
    // RFC 6749 §4.1.2.1: state is echoed only on redirectable errors from here on.
    const state = requestParams.state;

    // [resolve-jarm-response-mode] (feature: jarm) Interpret response_mode=query.jwt — JARM §2.3 / §3
    responseMode ??= resolveJarmResponseContext(requestParams, client, redirectUri, state, issuer, keys);

    // [resolve-form-post-response-mode] (feature: form-post-response-mode) Interpret response_mode=form_post — OAuth 2.0 Form Post Response Mode §2
    responseMode ??= resolveFormPostResponseContext(requestParams, issuer);

    // [resolve-fragment-response-mode] (feature: implicit-flow) Answer the Implicit Flow in the fragment — OAuth 2.0 Multiple Response Type Encoding Practices §2.1 / §3 / §5
    responseMode ??= resolveFragmentResponseContext(requestParams, issuer);

    // [validate-request] Validate the request parameters — OIDC Core 1.0 §3.1.2.1-§3.1.2.2 / OAuth 2.1 §4.1.1 / §7.5
    // OIDC Core 1.0 §6.3: request_uri / registration are not supported, and
    // request only when a Request Object was resolved above.
    rejectUnsupportedRequestParams(params, redirectUri, state, {
      requestParameterSupported: effectiveParams !== undefined,
    });

    // OIDC Core 1.0 §6.1: response_type / client_id inside the Request Object
    // must match the OAuth query parameters.
    validateRequestObjectConsistency(params, requestObjectClaims, redirectUri, state);

    // response_type: code, and the response types the features answer (the
    // authorize.responseTypes entry of their feature.ts), registered for the client.
    const responseType = validateResponseType(params, client, redirectUri, state, [
      'code',
      ...responseTypesOf(features),
    ]);

    // scope must be in the query (OIDC Core 1.0 §6.1) and contain openid (§3.1.2.1).
    let scope = validateAuthorizationScope(params, requestParams, redirectUri, state);

    // RFC 7591 §2: a client registered with a scope list (client.scope) may only
    // request those scopes. Any other one, offline_access included, is invalid_scope.
    validateClientScope(scope, client.scope, redirectUri, state);

    // OAuth 2.1 §4.1.1 / §7.5: PKCE with S256 (allowNonPkceAuthorizationCodeFlow
    // exists only for the OIDF Basic OP static-client compatibility target).
    // PKCE binds the authorization code, so a response type that returns none
    // (the Implicit Flow, OIDC Core 1.0 §3.2) has nothing to bind.
    const pkce = responseTypeIncludes(responseType, 'code')
      ? validateAuthorizationCodePkce(requestParams, client, redirectUri, state, {
        allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow,
      })
      : { codeChallenge: undefined, codeChallengeMethod: undefined };

    // OIDC Core 1.0 §3.1.2.1: prompt is none|login|consent|select_account.
    const prompt = validatePromptParameter(requestParams, redirectUri, state);

    // offline_access は 2 つの独立した条件を両方満たしたときだけ残る。
    // - OIDC Core 1.0 §11: エンドユーザーの同意（prompt=consent）
    // - RFC 7591 §2: クライアント登録の grant_types に refresh_token があること
    //   （既定は ["authorization_code"]）。無いまま offline_access を通すと、発行した
    //   Refresh Token が unauthorized_client で拒否されるだけの死んだ資格情報になる。
    // 認可コードを返さない response_type（Implicit Flow）の offline_access は、
    // applyOfflineAccessPolicy がコールバックに関わらず無視する（同 §11）。
    // 独自の許可条件を差し込むならコールバックを渡す（client も受け取れる）:
    //   scope = await applyOfflineAccessPolicy(scope, requestParams, prompt, client,
    //     (req, { promptValues }) => promptValues.includes('consent') || hasStoredConsent(req));
    // Without the refresh-token feature the callback always returns false, so
    // offline_access is never granted (OIDC Core 1.0 §11 requires ignoring the
    // request in that case).
    const refreshTokensOffered = tokenGrantsOf(features).includes('refresh_token');
    scope = await applyOfflineAccessPolicy(
      scope,
      requestParams,
      prompt,
      client,
      refreshTokensOffered ? undefined : () => false,
    );

    // RFC 6749 §3.3 / §4.1.2.1: this provider declares a scope allow list
    // (scopes.ts), so a value outside it is rejected instead of being carried
    // into the grant. Checked AFTER applyOfflineAccessPolicy on purpose: an
    // offline_access the policy already dropped stays "ignored" (OIDC Core 1.0
    // §11) instead of turning the request into invalid_scope.
    const unsupportedScopes = findUnsupportedScopes(scope);
    if (unsupportedScopes.length > 0) {
      throw new AuthorizationError(
        AuthorizationErrorCode.InvalidScope,
        'Unsupported scope: ' + unsupportedScopes.join(' '),
        redirectUri,
        state,
      );
    }

    // OIDC Core 1.0 §3.1.2.1: display is page|popup|touch|wap.
    const display = validateDisplayParameter(requestParams, redirectUri, state);

    // OIDC Core 1.0 §3.1.2.1 / Dynamic Client Registration 1.0 §2: max_age from
    // the request, falling back to the client's registered default_max_age.
    const maxAge = resolveMaxAge(requestParams, client, redirectUri, state);

    // Space-delimited audience for the access token.
    const audience = parseAudienceParameter(requestParams);

    // OIDC Core 1.0 §5.5: parse the claims request parameter (userinfo / id_token).
    const claims = parseClaimsRequestParameter(requestParams, redirectUri, state);

    // OIDC Core 1.0 §3.1.2.1: acr_values is optional, space-separated acr values
    // in order of preference, each of visible ASCII characters other than " and \.
    // The token endpoint puts the acr it settles on into the ID Token and the
    // access token (token/route.ts).
    const acrValues = validateAcrValuesParameter(requestParams, redirectUri, state);

    // [validate-implicit-request] (feature: implicit-flow) Validate the Implicit Flow request (response_mode, nonce, redirect_uri) — OIDC Core 1.0 §3.2.2.1 / OAuth 2.0 Multiple Response Type Encoding Practices §5
    validateImplicitRequest({ responseType, nonce: requestParams.nonce, redirectUri, state }, requestParams, client, responseMode);

    // [create-transaction] Create and store the authorization transaction — OIDC Core 1.0 §3.1.2.3
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
      redirectUriExplicit: requestParams.redirect_uri !== undefined,
      scope,
      codeChallenge: pkce.codeChallenge,
      codeChallengeMethod: pkce.codeChallengeMethod,
      state,
      nonce: requestParams.nonce,
      prompt,
      display,
      maxAge,
      uiLocales: requestParams.ui_locales,
      claimsLocales: requestParams.claims_locales,
      acrValues,
      loginHint: requestParams.login_hint,
      idTokenHint: requestParams.id_token_hint,
      audience,
      claims,
    };

    // The authentication transaction carries the request through login and
    // consent. csrfToken is embedded in their forms; transactionId never leaves
    // the OP except in the HttpOnly transaction cookie (buildTransactionCookie()
    // in _oidc-provider/cookies.ts).
    const csrfToken = generateRandomString(32);
    const transaction = createAuthTransaction(validatedRequest, csrfToken);
    const transactionId = generateRandomString(32);
    const transactionTtlSeconds = 10 * 60;
    // The consent step only sees the transaction it reads back from the store,
    // so the requested response mode is recorded on it (the transaction store
    // MUST persist fields it does not know about).
    const storedTransaction: ResponseModeTransaction = responseMode
      ? { ...transaction, responseMode: responseMode.name }
      : transaction;
    await transactionStore.put('auth_txn:' + transactionId, storedTransaction, transactionTtlSeconds);

    // [validate-prompt-combination] Reject prompt=none combined with other values — OIDC Core 1.0 §3.1.2.1
    // OIDC Core 1.0 §3.1.2.1: prompt is a space-delimited list.
    const promptValues = transaction.prompt?.trim().split(/\s+/).filter(Boolean) ?? [];

    // prompt=none must not be combined with other values (OIDC Core 1.0 §3.1.2.1).
    if (promptValues.includes('none') && promptValues.length > 1) {
      await transactionStore.delete('auth_txn:' + transactionId);
      return await errorRedirect(responseMode, transaction.redirectUri, 'invalid_request', transaction.state, 'prompt=none must not be combined with other prompt values');
    }

    // [verify-id-token-hint] Verify id_token_hint — OIDC Core 1.0 §3.1.2.1
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
        return await errorRedirect(responseMode, transaction.redirectUri, code, transaction.state, hintError instanceof Error && hintError.message ? hintError.message : 'id_token_hint verification failed');
      }
    }

    // [authenticate-silently] prompt=none: authenticate without interaction — OIDC Core 1.0 §3.1.2.1
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

        // Apply the scope policy BEFORE the consent lookup: looking up consent for
        // a scope this End-User can never hold would answer consent_required
        // forever (OIDC Core 1.0 §3.1.2.1). See resolveGrantableScopes() in
        // scopes.ts.
        transaction.scope = (await resolveGrantableScopes(
          transaction.scope.split(' ').filter(Boolean),
          session.subject,
        )).join(' ');

        // OIDC Core 1.0 §3.1.2.1: not consented → consent_required (the OP must
        // not show a consent screen for prompt=none).
        await validatePromptNoneConsent(transaction, session, consentResolver);
      } catch (promptError) {
        await transactionStore.delete('auth_txn:' + transactionId);
        if (promptError instanceof AuthorizationError) {
          return await errorRedirect(responseMode, transaction.redirectUri, promptError.error, transaction.state, promptError.errorDescription);
        }
        const serverDescription =
          promptError instanceof Error && promptError.message
            ? promptError.message
            : 'Unexpected error while evaluating prompt=none';
        return await errorRedirect(responseMode, transaction.redirectUri, 'server_error', transaction.state, serverDescription);
      }

      // OIDC Core 1.0 §3.1.2.1: a session older than max_age cannot be refreshed
      // without interaction, which prompt=none forbids.
      if (transaction.maxAge !== undefined && requiresReauthentication(transaction.maxAge, session.authTime)) {
        await transactionStore.delete('auth_txn:' + transactionId);
        return await errorRedirect(responseMode, transaction.redirectUri, 'login_required', transaction.state, 'Session exceeds the requested max_age; re-authentication required');
      }

      return await issueAuthorizationResponse(transactionId, transaction, session, responseMode);
    }

    // [reuse-session] Single Sign-On: reuse the active OP session — OIDC Core 1.0 §3.1.2.3
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
        // Apply the scope policy before the consent lookup, for the same reason
        // as the prompt=none path. The narrowed value is only held in memory:
        // the consent step applies the policy again to what it grants.
        transaction.scope = (await resolveGrantableScopes(
          transaction.scope.split(' ').filter(Boolean),
          existingSession.subject,
        )).join(' ');

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
          return await issueAuthorizationResponse(transactionId, transaction, existingSession, responseMode);
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

    // [continue-to-login] Continue on the login screen — OIDC Core 1.0 §3.1.2.3
    // Interactive authentication (prompt=login forces it even with a session).
    return redirectToScreen('/login', transactionId, transactionTtlSeconds);
  } catch (error) {
    // [respond-error] Answer the error (redirect or OP error page) — OIDC Core 1.0 §3.1.2.6 / RFC 6749 §4.1.2.1
    if (error instanceof AuthorizationError) {
      if (error.redirectUri) {
        return await errorRedirect(responseMode, error.redirectUri, error.error, error.state, error.errorDescription);
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
 * The authorization response for an End-User who needs no screen
 * (prompt=none, or SSO with prior consent): finish the transaction and answer
 * the client with what the response type returns. OIDC Core 1.0 §3.1.2.5 /
 * §3.1.3.1 / RFC 9207 §2
 *
 * transaction.scope は認可リクエスト検証時に applyOfflineAccessPolicy を通した
 * 後の値。offline_access の可否（OIDC Core 1.0 §11 の prompt=consent と、
 * クライアント登録 grant_types に refresh_token があるか）はそこで判定済みなので、
 * ここで再フィルタしない。
 */
async function issueAuthorizationResponse(
  transactionId: string,
  transaction: AuthTransaction,
  session: SessionInfo,
  responseMode: AuthorizationResponseMode | undefined,
): Promise<Response> {
  // [issue-implicit-response] (feature: implicit-flow) Issue the ID Token (and access token) in place of the code — OIDC Core 1.0 §3.2.2.5
  const implicitResponse = await issueImplicitResponse({ transactionId, transaction, session, responseMode });
  if (implicitResponse) return implicitResponse;

  // [issue-authorization-code] Issue the authorization code — OIDC Core 1.0 §3.1.2.5 / §3.1.3.1
  const grantedScope = transaction.scope.split(' ').filter(Boolean);
  const responseParams = await completeAuthTransaction(transactionId, transaction, transactionStore);
  const authCodeData = await createAuthorizationCode({
    authorizationResponse: { ...responseParams, scope: grantedScope },
    subject: session.subject,
    authTime: session.authTime,
    // online refresh token を、このログインセッション（prompt=none や SSO で
    // 再利用したもの）へ束縛するために引き継ぐ。セッションが終われば、その RT は
    // invalid_grant になる。
    sessionId: session.sessionId,
    // OIDC Core 1.0 §3.1.3.1: TTL は ProviderConfig から設定可能（既定 300 秒）。
    ttlSeconds: config.authorizationCodeTtl,
  });
  await authCodeStore.set(authCodeData.code, authCodeData);
  // Withdrawing the consent revokes the tokens issued from this grant.
  await consentResolver.recordGrant(session.subject, transaction.clientId, authCodeData.grantId);

  return successRedirect(responseMode, transaction.redirectUri, authCodeData.code, transaction.state);
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
 * Send an authorization response back to the client: in the response mode the
 * request asked for (JARM's query.jwt, the form of form_post), or with the
 * parameters in the query and iss appended (RFC 9207 §2).
 */
async function redirectToClient(
  responseMode: AuthorizationResponseMode | undefined,
  redirectUri: string,
  parameters: Record<string, string | undefined>,
): Promise<Response> {
  return respondToClient(await authorizationResponseOf(responseMode, redirectUri, parameters, config.issuer));
}

/**
 * A redirectable error (OIDC Core 1.0 §3.1.2.6 / RFC 6749 §4.1.2.1).
 * error_description is reduced to the RFC 6749 §5.2 character set, so a
 * user-controlled fragment cannot smuggle control bytes into the URL.
 */
function errorRedirect(
  responseMode: AuthorizationResponseMode | undefined,
  redirectUri: string,
  error: string,
  state?: string,
  errorDescription?: string,
): Promise<Response> {
  return redirectToClient(responseMode, redirectUri, {
    error,
    error_description: errorDescription ? sanitizeErrorDescription(errorDescription) : undefined,
    state,
  });
}

/** The authorization response carrying the code (OIDC Core 1.0 §3.1.2.5). */
function successRedirect(
  responseMode: AuthorizationResponseMode | undefined,
  redirectUri: string,
  code: string,
  state: string | undefined,
): Promise<Response> {
  return redirectToClient(responseMode, redirectUri, { code, state });
}
