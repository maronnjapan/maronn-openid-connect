/**
 * Next.js template for the Authorization Endpoint Route Handler
 * (`authorize/route.ts`).
 */
import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';
import { EXPERIMENTAL_PACKAGE } from '../hono/templates.js';

/** `authorize/route.ts` — OIDC Core 1.0 §3.1.2. */
export function nextJsAuthorizeRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
): string {
  const jarm = features.jarm;
  // Under JARM every response URL is signed, which is async: each call site
  // gains an await and the response context argument.
  const respAwait = jarm ? 'await ' : '';
  const jarmArg = jarm ? 'jarmResponse, ' : '';

  // --- Custom scopes (--scope) ----------------------------------------------
  const customScopesDeclared = scopes.length > 0;
  const customScopeImport = customScopesDeclared
    ? `
import { findUnsupportedScopes, resolveGrantableScopes } from '../_oidc-provider/scopes';`
    : '';
  const customScopeStep = customScopesDeclared
    ? `
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
`
    : '';
  const promptNoneScopeStep = customScopesDeclared
    ? `
        // Apply the scope policy BEFORE the consent lookup: looking up consent for
        // a scope this End-User can never hold would answer consent_required
        // forever (OIDC Core 1.0 §3.1.2.1). See resolveGrantableScopes() in
        // scopes.ts.
        transaction.scope = (await resolveGrantableScopes(
          transaction.scope.split(' ').filter(Boolean),
          session.subject,
        )).join(' ');
`
    : '';
  const ssoScopeStep = customScopesDeclared
    ? `        // Apply the scope policy before the consent lookup, for the same reason
        // as the prompt=none path. The narrowed value is only held in memory:
        // the consent step applies the policy again to what it grants.
        transaction.scope = (await resolveGrantableScopes(
          transaction.scope.split(' ').filter(Boolean),
          existingSession.subject,
        )).join(' ');

`
    : '';

  // --- Transaction binding (--enable transaction-binding) -------------------
  const bindingStoreImport = features.transactionBinding
    ? `
import { buildTransactionBindingCookie } from '../_oidc-provider/store';`
    : '';
  const transactionCreation = features.transactionBinding
    ? `    // OIDC Core 1.0 §3.1.2.3 / §3.1.2.4: the End-User who authenticates and
    // consents must be the one behind THIS User-Agent. transaction_id alone cannot
    // prove that (it rides in the URL and can leak), so a secret is handed to this
    // browser in an HttpOnly cookie and only its hash is kept on the transaction.
    // See buildTransactionBindingCookie() in store.ts for the threat this closes.
    const bindingSecret = generateRandomString(32);
    const transaction = createAuthTransaction(validatedRequest, csrfToken, {
      bindingHash: await computeTransactionBindingHash(bindingSecret),
    });
`
    : `    const transaction = createAuthTransaction(validatedRequest, csrfToken);
`;
  // The binding cookie travels with the answers that continue in this browser
  // (login / consent); paths that go straight back to the client need none.
  const screenCookieArg = features.transactionBinding
    ? ', buildTransactionBindingCookie(transactionId, bindingSecret, transactionTtlSeconds)'
    : '';
  const redirectToScreenSignature = features.transactionBinding
    ? `function redirectToScreen(
  path: '/login' | '/consent',
  transactionId: string,
  bindingCookie: string,
): Response {`
    : `function redirectToScreen(path: '/login' | '/consent', transactionId: string): Response {`;
  const redirectToScreenCookie = features.transactionBinding
    ? `
  response.headers.append('Set-Cookie', bindingCookie);`
    : '';

  // --- Request Object (request-object feature) ------------------------------
  const requestObjectStep = features.requestObject
    ? `    // OIDC Core 1.0 §6.1: verify the signed Request Object (request parameter)
    // against the client's registered JWKS and overlay its claims onto the query
    // parameters. RS256 is required; alg=none is accepted only when
    // allowUnsignedRequestObject is enabled (conformance compat).
    // effectiveParams is what every later step validates.
    const { effectiveParams, requestObjectClaims } = await resolveRequestObjectParams(
      params,
      client,
      { allowUnsigned: config.allowUnsignedRequestObject },
    );
`
    : `    // OIDC Core 1.0 §6.3: the request parameter (Request Object) is disabled in
    // this generated provider; rejectUnsupportedRequestParams below rejects it
    // with request_not_supported. The effective parameters are the query as-is.
    const effectiveParams = params;
`;
  const rejectUnsupportedStep = features.requestObject
    ? `    // OIDC Core 1.0 §6.3: request_uri / registration are not supported here.
    rejectUnsupportedRequestParams(params, redirectUri, state);

    // OIDC Core 1.0 §6.1: response_type / client_id inside the Request Object
    // must match the OAuth query parameters.
    validateRequestObjectConsistency(params, requestObjectClaims, redirectUri, state);
`
    : `    // OIDC Core 1.0 §6.3: request (disabled here) / request_uri / registration
    // are not supported and rejected explicitly.
    rejectUnsupportedRequestParams(params, redirectUri, state, {
      requestParameterSupported: false,
    });
`;

  // --- Pushed Authorization Requests (--enable par) -------------------------
  const parImports = features.par
    ? `
import {
  PushedRequestUriError,
  assertPushedRequestUsed,
  resolvePushedRequestUri,
} from '${EXPERIMENTAL_PACKAGE}/par';
import { parConfig } from '../par/config';`
    : '';
  const paramsBinding = features.par ? 'let params = rawParams;' : 'const params = rawParams;';
  // Runs inside the try block so a PushedRequestUriError reaches the catch below.
  const parResolveStep = features.par
    ? `    // EXPERIMENTAL — Pushed Authorization Requests (RFC 9126 §4).
    // RFC 9126 §5: with require_pushed_authorization_requests on, a request that
    // did not go through /par is rejected outright.
    if (parConfig.requirePushedAuthorizationRequests) {
      assertPushedRequestUsed(rawParams);
    }
    // Expand a request_uri of the form urn:ietf:params:oauth:request_uri:<ref>
    // into the parameters pushed to /par. The reference is single use and short
    // lived, so reloading this URL fails with invalid_request_uri by design.
    // Anything that is not such a URN (absent, or an OIDC Core §6.2 URL) returns
    // null and is left to the pipeline, which rejects it with
    // request_uri_not_supported.
    const pushedParams = await resolvePushedRequestUri({ params: rawParams, store: parStore });
    if (pushedParams !== null) {
      if (!isAuthorizationRequestParams(pushedParams)) {
        // Defensive: client_id was validated when the request was pushed.
        throw new PushedRequestUriError('invalid_request_uri', 'The request_uri is invalid, expired, or has already been used');
      }
      params = pushedParams;
    }

`
    : '';
  const parCatchBranch = features.par
    ? `    if (error instanceof PushedRequestUriError) {
      // RFC 9126 §4 / OIDC Core 1.0 §3.1.2.6: without a resolvable request_uri
      // there is no verified redirect_uri, so this error is NEVER redirected
      // (RFC 6749 §4.1.2.1). Every failure kind (unknown / used / expired /
      // another client's) answers identically, so the response is no existence
      // oracle.
      return nonRedirectableError(request, error.code, error.errorDescription);
    }
`
    : '';

  // --- JARM (--enable jarm) --------------------------------------------------
  const jarmImports = jarm
    ? `
import {
  buildJarmRedirectUrl,
  createJarmResponseJwt,
  resolveJarmResponseMode,
  type JarmAuthTransactionFields,
} from '${EXPERIMENTAL_PACKAGE}/jarm';
import { jarmConfig } from '../_oidc-provider/jarm';`
    : '';
  // Declared before the try block: the catch below decides how to answer a
  // redirectable error and cannot see anything declared inside the try.
  const jarmResponseBinding = jarm
    ? `
  // EXPERIMENTAL — JARM §2.3. Set once redirect_uri is verified; undefined means
  // the plain query response.
  let jarmResponse: JarmResponseContext | undefined;`
    : '';
  const jarmResolveStep = jarm
    ? `    // EXPERIMENTAL — JARM §2.3: interpret response_mode now that redirect_uri is
    // verified, so an unsupported JWT mode can be reported as a redirectable
    // error. Values outside the \`.jwt\` family stay ignored as before.
    const jarmResolution = resolveJarmResponseMode(effectiveParams);
    if (jarmResolution.kind === 'unsupported-jwt-mode') {
      // JARM §2.3.2 / §2.3.3 (fragment.jwt / form_post.jwt) are not implemented.
      // The rejection itself goes back as a PLAIN query error: the OP cannot
      // answer in a response mode it does not implement.
      throw new AuthorizationError(
        AuthorizationErrorCode.InvalidRequest,
        'response_mode ' + jarmResolution.requested + ' is not supported',
        redirectUri,
        state,
      );
    }
    if (jarmResolution.kind === 'jarm') {
      // JARM §3: the response JWT declares alg RS256 (the default for a client
      // that registered no authorization_signed_response_alg). The first key of
      // the set is not guaranteed to be RS256, so the key is picked by alg from
      // the set — its public half is published at /.well-known/jwks.json under
      // the same kid. selectSigningKeyByAlg throws when no RS256 key is
      // registered, which surfaces as a server_error (a configuration mistake).
      jarmResponse = {
        issuer,
        clientId: client.clientId,
        signingKey: selectSigningKeyByAlg(keys.general, 'RS256'),
      };
    }

`
    : '';
  // The consent step only sees the transaction it reads back from the store, so
  // the mode is recorded on it (the transaction store MUST persist fields it
  // does not know about).
  const transactionStorage = jarm
    ? `    // EXPERIMENTAL — JARM: the consent step only sees the transaction it reads
    // back from the store, so the requested response mode is recorded on it (the
    // transaction store MUST persist fields it does not know about).
    const storedTransaction: AuthTransaction & JarmAuthTransactionFields = jarmResponse
      ? { ...transaction, jarmResponseMode: 'query.jwt' }
      : transaction;
    await transactionStore.put('auth_txn:' + transactionId, storedTransaction, transactionTtlSeconds);
`
    : `    await transactionStore.put('auth_txn:' + transactionId, transaction, transactionTtlSeconds);
`;
  const responseHelpers = jarm
    ? `/**
 * EXPERIMENTAL — JARM response context (JARM §2.1). Present only for a request
 * that asked for response_mode=query.jwt (or its \`jwt\` shorthand); undefined
 * means the plain query response.
 */
interface JarmResponseContext {
  issuer: string;
  clientId: string;
  signingKey: SigningKey;
}

/**
 * Send an authorization response back to the client.
 *
 * Plain mode: the parameters ride in the query, with iss appended (RFC 9207 §2).
 * EXPERIMENTAL JARM mode (JARM §2.3.1): the same parameters become claims of one
 * signed JWT in the \`response\` parameter, and no plain parameter is added — the
 * JWT's iss claim identifies the issuer (RFC 9700 §2.1 accepts JARM for that).
 */
async function redirectToClient(
  jarm: JarmResponseContext | undefined,
  redirectUri: string,
  parameters: Record<string, string | undefined>,
): Promise<Response> {
  if (jarm) {
    const location = buildJarmRedirectUrl(
      redirectUri,
      await createJarmResponseJwt({
        issuer: jarm.issuer,
        clientId: jarm.clientId,
        parameters,
        signingKey: jarm.signingKey,
        lifetimeSeconds: jarmConfig.jarmResponseLifetimeSeconds,
      }),
    );
    return NextResponse.redirect(location, 302);
  }
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  url.searchParams.set('iss', config.issuer);
  return NextResponse.redirect(url, 302);
}

/**
 * A redirectable error (OIDC Core 1.0 §3.1.2.6 / RFC 6749 §4.1.2.1).
 * error_description is reduced to the RFC 6749 §5.2 character set, so a
 * user-controlled fragment cannot smuggle control bytes into the URL.
 */
function errorRedirect(
  jarm: JarmResponseContext | undefined,
  redirectUri: string,
  error: string,
  state?: string,
  errorDescription?: string,
): Promise<Response> {
  return redirectToClient(jarm, redirectUri, {
    error,
    error_description: errorDescription ? sanitizeErrorDescription(errorDescription) : undefined,
    state,
  });
}

/** The authorization response carrying the code (OIDC Core 1.0 §3.1.2.5). */
function successRedirect(
  jarm: JarmResponseContext | undefined,
  redirectUri: string,
  code: string,
  state: string | undefined,
): Promise<Response> {
  return redirectToClient(jarm, redirectUri, { code, state });
}`
    : `/**
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
}`;

  const offlineAccessStep = features.refreshToken
    ? `    // offline_access は 2 つの独立した条件を両方満たしたときだけ残る。
    // - OIDC Core 1.0 §11: エンドユーザーの同意（prompt=consent）
    // - RFC 7591 §2: クライアント登録の grant_types に refresh_token があること
    //   （既定は ["authorization_code"]）。無いまま offline_access を通すと、発行した
    //   Refresh Token が unauthorized_client で拒否されるだけの死んだ資格情報になる。
    // 独自の許可条件を差し込むならコールバックを渡す（client も受け取れる）:
    //   scope = await applyOfflineAccessPolicy(scope, effectiveParams, prompt, client,
    //     (req, { promptValues }) => promptValues.includes('consent') || hasStoredConsent(req));
    scope = await applyOfflineAccessPolicy(scope, effectiveParams, prompt, client);
`
    : `    // The refresh_token feature is disabled in this generated provider: the
    // callback always returns false, so offline_access is never granted
    // (OIDC Core 1.0 §11 requires ignoring the request in that case).
    scope = await applyOfflineAccessPolicy(scope, effectiveParams, prompt, client, () => false);
`;

  const coreImports = [
    'resolveClientForAuthorization',
    'validateRegisteredRedirectUris',
    ...(features.requestObject
      ? ['resolveRequestObjectParams', 'validateRequestObjectConsistency']
      : []),
    'resolveAuthorizationRedirectUri',
    'rejectUnsupportedRequestParams',
    'validateResponseType',
    'validateAuthorizationScope',
    'validateAuthorizationCodePkce',
    'validatePromptParameter',
    'applyOfflineAccessPolicy',
    'validateDisplayParameter',
    'resolveMaxAge',
    'parseAudienceParameter',
    'parseClaimsRequestParameter',
    'validateIdTokenHint',
    'createAuthTransaction',
    ...(features.transactionBinding ? ['computeTransactionBindingHash'] : []),
    'createAuthorizationCode',
    'completeAuthTransaction',
    'generateRandomString',
    'resolvePromptNoneSession',
    'validatePromptNoneIdTokenHint',
    'validatePromptNoneConsent',
    'requiresReauthentication',
    'sanitizeErrorDescription',
    ...(jarm ? ['selectSigningKeyByAlg'] : []),
    'AuthorizationError',
    ...(jarm || customScopesDeclared ? ['AuthorizationErrorCode'] : []),
    'IdTokenHintError',
    ...(jarm ? ['type AuthTransaction'] : []),
    'type AuthorizationRequestParams',
    ...(jarm ? ['type SigningKey'] : []),
  ];
  const parStoreImport = features.par ? '\n  parStore,' : '';

  return `/**
 * Authorization Endpoint (OIDC Core 1.0 §3.1.2).
 *
 * The browser's entry into the flow, so every answer is a redirect: back to the
 * client with the authorization response, on to the login or consent screen,
 * or — for an error that must not go back to the client — to the OP's own
 * error page (app/oidc-error).
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
${coreImports.map((name) => `  ${name},`).join('\n')}
} from '${corePkg}';${parImports}${jarmImports}
import {
  clientResolver,
  config,
  idTokenHintJwks,
  loadSigningKeys,${parStoreImport}
  resolvers,
  stores,
} from '../_oidc-provider/provider';
import {
  isFormUrlEncoded,
  redirectToErrorPage,
  signingKeysUnavailable,
  uniqueParams,
  type UniqueParams,
} from '../_oidc-provider/http';${bindingStoreImport}${customScopeImport}

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
    return badRequest(\`Parameter "\${parsed.duplicateKey}" must not be repeated\`);
  }

  const rawParams = parsed.params;
  if (!isAuthorizationRequestParams(rawParams)) {
    return badRequest('Missing required parameter: client_id');
  }

  ${paramsBinding}${jarmResponseBinding}
  // RFC 9207 §2: every authorization response (success and error) carries the
  // issuer identifier, so clients can pin the issuer that produced it.
  const issuer = config.issuer;

  try {
${parResolveStep}    // --- Authorization request validation pipeline ---------------------------
    // Each step below is an independent core function, called in the same order
    // as core's validateAuthorizationRequest(). Delete a call to drop that
    // validation, or insert your own logic between steps. Steps that run before
    // redirectUri is resolved throw non-redirectable errors (shown on the OP);
    // steps after it throw redirectable errors (sent back to the client).

    // OAuth 2.1 §4.1.2.1: resolve client_id into the registered client.
    const client = await resolveClientForAuthorization(params, clientResolver);

    // Fail fast on misconfigured registered redirect URIs (fragments, dangerous
    // schemes, non-loopback http) — OIDC Core 1.0 §3.1.2.1 / RFC 8252 §8.
    validateRegisteredRedirectUris(client.redirectUris);

${requestObjectStep}
    // Resolve redirect_uri against the registered URIs (OIDC Core 1.0 §3.1.2.1).
    const redirectUri = resolveAuthorizationRedirectUri(effectiveParams, client);
    // RFC 6749 §4.1.2.1: state is echoed only on redirectable errors from here on.
    const state = effectiveParams.state;

${jarmResolveStep}${rejectUnsupportedStep}
    // response_type=code and per-client response_type authorization.
    const responseType = validateResponseType(params, client, redirectUri, state);

    // scope must be in the query (OIDC Core 1.0 §6.1) and contain openid (§3.1.2.1).
    let scope = validateAuthorizationScope(params, effectiveParams, redirectUri, state);

    // OAuth 2.1 §4.1.1 / §7.5: PKCE with S256 (allowNonPkceAuthorizationCodeFlow
    // exists only for the OIDF Basic OP static-client compatibility target).
    const pkce = validateAuthorizationCodePkce(effectiveParams, client, redirectUri, state, {
      allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow,
    });

    // OIDC Core 1.0 §3.1.2.1: prompt is none|login|consent|select_account.
    const prompt = validatePromptParameter(effectiveParams, redirectUri, state);

${offlineAccessStep}${customScopeStep}
    // OIDC Core 1.0 §3.1.2.1: display is page|popup|touch|wap.
    const display = validateDisplayParameter(effectiveParams, redirectUri, state);

    // OIDC Core 1.0 §3.1.2.1 / Dynamic Client Registration 1.0 §2: max_age from
    // the request, falling back to the client's registered default_max_age.
    const maxAge = resolveMaxAge(effectiveParams, client, redirectUri, state);

    // Space-delimited audience for the access token.
    const audience = parseAudienceParameter(effectiveParams);

    // OIDC Core 1.0 §5.5: parse the claims request parameter (userinfo / id_token).
    const claims = parseClaimsRequestParameter(effectiveParams, redirectUri, state);

    // Assemble the validated request from each step's result. This shape matches
    // core's validateAuthorizationRequest(), so transactions and authorization
    // codes are unaffected by adding or removing steps above.
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

    // The authentication transaction carries the request through login and consent.
    const csrfToken = generateRandomString(32);
${transactionCreation}    const transactionId = generateRandomString(32);
    const transactionTtlSeconds = 10 * 60;
${transactionStorage}
    // OIDC Core 1.0 §3.1.2.1: prompt is a space-delimited list.
    const promptValues = transaction.prompt?.trim().split(/\\s+/).filter(Boolean) ?? [];

    // prompt=none must not be combined with other values (OIDC Core 1.0 §3.1.2.1).
    if (promptValues.includes('none') && promptValues.length > 1) {
      await transactionStore.delete('auth_txn:' + transactionId);
      return ${respAwait}errorRedirect(${jarmArg}transaction.redirectUri, 'invalid_request', transaction.state, 'prompt=none must not be combined with other prompt values');
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
        return ${respAwait}errorRedirect(${jarmArg}transaction.redirectUri, code, transaction.state, hintError instanceof Error && hintError.message ? hintError.message : 'id_token_hint verification failed');
      }
    }

    // prompt=none: silent authentication without any user interaction
    // (OIDC Core 1.0 §3.1.2.1).
    if (promptValues.includes('none')) {
      let session;
      try {
        // --- prompt=none pipeline -------------------------------------------
        // Each step below is an independent core function, called in the same
        // order as core's checkPromptNone(). Every step throws
        // AuthorizationError(login_required | consent_required) on failure.

        // OIDC Core 1.0 §3.1.2.1: no active session → login_required (the OP
        // must not show a login screen for prompt=none).
        session = await resolvePromptNoneSession(transaction, sessionResolver, request);

        // verifiedHintSubject は上流（prompt 非依存の検証ブロック）で確定済み。
        // ここでは prompt=none 固有の「不一致なら login_required」判定だけを行う。
        // コンセント確認より前に置くのは、コンセント検索が session.subject をキーに
        // するため — 不一致のまま進むと別ユーザーのコンセントを見てしまう。
        validatePromptNoneIdTokenHint(transaction, session, verifiedHintSubject);
${promptNoneScopeStep}
        // OIDC Core 1.0 §3.1.2.1: not consented → consent_required (the OP must
        // not show a consent screen for prompt=none).
        await validatePromptNoneConsent(transaction, session, consentResolver);
      } catch (promptError) {
        await transactionStore.delete('auth_txn:' + transactionId);
        if (promptError instanceof AuthorizationError) {
          return ${respAwait}errorRedirect(${jarmArg}transaction.redirectUri, promptError.error, transaction.state, promptError.errorDescription);
        }
        const serverDescription =
          promptError instanceof Error && promptError.message
            ? promptError.message
            : 'Unexpected error while evaluating prompt=none';
        return ${respAwait}errorRedirect(${jarmArg}transaction.redirectUri, 'server_error', transaction.state, serverDescription);
      }

      // OIDC Core 1.0 §3.1.2.1: a session older than max_age cannot be refreshed
      // without interaction, which prompt=none forbids.
      if (transaction.maxAge !== undefined && requiresReauthentication(transaction.maxAge, session.authTime)) {
        await transactionStore.delete('auth_txn:' + transactionId);
        return ${respAwait}errorRedirect(${jarmArg}transaction.redirectUri, 'login_required', transaction.state, 'Session exceeds the requested max_age; re-authentication required');
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

      return ${respAwait}successRedirect(${jarmArg}transaction.redirectUri, authCodeData.code, transaction.state);
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
${ssoScopeStep}        // OIDC Core 1.0 §3.1.2.1: prompt=consent MUST re-display the consent UI.
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

          return ${respAwait}successRedirect(${jarmArg}transaction.redirectUri, authCodeData.code, transaction.state);
        }

        // Signed in already: hand the subject to the consent step.
        await authSessionStore.set(transactionId, {
          subject: existingSession.subject,
          authTime: existingSession.authTime,
          // consent 画面を経由しても online refresh token の束縛先を見失わないよう、
          // login → consent の受け渡しに sessionId も載せる。
          sessionId: existingSession.sessionId,
        });
        return redirectToScreen('/consent', transactionId${screenCookieArg});
      }
    }

    // Interactive authentication (prompt=login forces it even with a session).
    return redirectToScreen('/login', transactionId${screenCookieArg});
  } catch (error) {
${parCatchBranch}    if (error instanceof AuthorizationError) {
      if (error.redirectUri) {
        return ${respAwait}errorRedirect(${jarmArg}error.redirectUri, error.error, error.state, error.errorDescription);
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
 * Continue on one of the OP's own screens. The URL is built on config.issuer,
 * never on the request URL: some platforms derive the request URL from the Host
 * header, which would let the sender choose where transaction_id lands
 * (OIDC Discovery 1.0 §3 / RFC 9700 §2.1).
 */
${redirectToScreenSignature}
  const url = new URL(path, config.issuer);
  url.searchParams.set('transaction_id', transactionId);
  const response = NextResponse.redirect(url, 302);${redirectToScreenCookie}
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

${responseHelpers}
`;
}
