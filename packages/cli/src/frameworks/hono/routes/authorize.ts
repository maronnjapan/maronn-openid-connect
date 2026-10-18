/**
 * Authorization endpoint (`routes/authorize.ts`) for the hono / express /
 * fastify output: one fragment per step of the `authorize` endpoint of the
 * flow catalog, assembled by renderPipelineRoute().
 */
import { DEFAULT_FEATURES } from '../../../registry.js';
import type { OidcFeatureConfig } from '../../../registry.js';
import { buildOpFlow } from '../../../flow/catalog.js';
import { EXPERIMENTAL_PACKAGE } from '../../packages.js';
import { renderPipelineRoute, type StepFragment } from '../pipeline.js';

interface AuthorizeTemplateContext {
  features: OidcFeatureConfig;
  customScopes: boolean;
  /** `effectiveParams` with the request-object feature, `params` without it. */
  effective: string;
  /** JARM turns the redirect helpers async and adds the response context argument. */
  awaitKw: string;
  jarmArg: string;
  /** `, jarmResponse` / `, jarmResponse?: ...` fragments for the steps that build redirects. */
  jarmParam: string;
  jarmCallArg: string;
}

function templateContext(features: OidcFeatureConfig, scopes: string[]): AuthorizeTemplateContext {
  return {
    features,
    customScopes: scopes.length > 0,
    effective: features.requestObject ? 'effectiveParams' : 'params',
    awaitKw: features.jarm ? 'await ' : '',
    jarmArg: features.jarm ? 'jarmResponse, ' : '',
    jarmParam: features.jarm ? ',\n  jarmResponse: JarmResponseContext | undefined' : '',
    jarmCallArg: features.jarm ? ', jarmResponse' : '',
  };
}

function authorizeHeader(ctx: AuthorizeTemplateContext): string {
  const redirectHelpers = ctx.features.jarm
    ? `/**
 * EXPERIMENTAL — JARM response context (JARM Section 2.1).
 *
 * Present only for a request that asked for response_mode=query.jwt (or its
 * \`jwt\` shorthand). undefined means the plain query response this OP has always
 * produced, so a client that does not ask for JARM sees no change at all.
 */
export type JarmResponseContext = {
  issuer: string;
  clientId: string;
  signingKey: SigningKey;
};

/**
 * Builds a redirect URL with an OAuth error response.
 * OIDC Core 1.0 Section 3.1.2.6 / RFC 6749 Section 4.1.2.1.
 *
 * errorDescription is optional; when supplied it is sanitized to the RFC 6749
 * Section 5.2 allowed character set before being appended so user-controlled
 * fragments cannot smuggle control bytes into the redirect URL.
 *
 * RFC 9207 Section 2: when issuer is provided, the iss parameter is appended so
 * the client can pin the issuer that produced this authorization response.
 *
 * EXPERIMENTAL (JARM Section 2.1 / 2.3.1): when jarm is present the very same
 * parameters travel as claims of one signed JWT in the \`response\` query
 * parameter instead, and no plain error / error_description / state / iss
 * parameter is added — the JWT's iss claim identifies the issuer (RFC 9700
 * Section 2.1 accepts JARM as the issuer-identification mechanism).
 */
async function buildErrorRedirect(
  jarm: JarmResponseContext | undefined,
  redirectUri: string,
  error: string,
  state?: string,
  errorDescription?: string,
  issuer?: string,
): Promise<string> {
  // RFC 6749 Section 5.2: sanitize once, for both response shapes.
  const description = errorDescription
    ? sanitizeErrorDescription(errorDescription)
    : undefined;
  if (jarm) {
    return buildJarmRedirectUrl(
      redirectUri,
      await createJarmResponseJwt({
        issuer: jarm.issuer,
        clientId: jarm.clientId,
        parameters: { error, error_description: description, state },
        signingKey: jarm.signingKey,
        lifetimeSeconds: jarmConfig.jarmResponseLifetimeSeconds,
      }),
    );
  }
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) {
    url.searchParams.set('error_description', description);
  }
  if (state) url.searchParams.set('state', state);
  if (issuer) url.searchParams.set('iss', issuer);
  return url.toString();
}

/**
 * Builds the success redirect URL carrying the authorization code.
 * OIDC Core 1.0 Section 3.1.2.5 / RFC 9207 Section 2 (iss).
 *
 * EXPERIMENTAL (JARM Section 2.3.1): when jarm is present the code and state
 * become claims of a signed JWT delivered as the single \`response\` parameter;
 * no plain code / state / iss parameter is added.
 */
async function buildSuccessRedirect(
  jarm: JarmResponseContext | undefined,
  redirectUri: string,
  code: string,
  state: string | undefined,
  issuer: string,
): Promise<string> {
  if (jarm) {
    return buildJarmRedirectUrl(
      redirectUri,
      await createJarmResponseJwt({
        issuer: jarm.issuer,
        clientId: jarm.clientId,
        parameters: { code, state },
        signingKey: jarm.signingKey,
        lifetimeSeconds: jarmConfig.jarmResponseLifetimeSeconds,
      }),
    );
  }
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  // RFC 9207 Section 2: include iss in success responses.
  url.searchParams.set('iss', issuer);
  return url.toString();
}`
    : `/**
 * Builds a redirect URL with an OAuth error response.
 * OIDC Core 1.0 Section 3.1.2.6 / RFC 6749 Section 4.1.2.1.
 *
 * errorDescription is optional; when supplied it is sanitized to the RFC 6749
 * Section 5.2 allowed character set before being appended so user-controlled
 * fragments cannot smuggle control bytes into the redirect URL.
 *
 * RFC 9207 §2: when issuer is provided, the iss parameter is appended so the
 * client can pin the issuer that produced this authorization response.
 */
function buildErrorRedirect(
  redirectUri: string,
  error: string,
  state?: string,
  errorDescription?: string,
  issuer?: string,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (errorDescription) {
    url.searchParams.set('error_description', sanitizeErrorDescription(errorDescription));
  }
  if (state) url.searchParams.set('state', state);
  if (issuer) url.searchParams.set('iss', issuer);
  return url.toString();
}

/**
 * Builds the success redirect URL carrying the authorization code.
 * OIDC Core 1.0 Section 3.1.2.5 / RFC 9207 Section 2 (iss).
 */
function buildSuccessRedirect(
  redirectUri: string,
  code: string,
  state: string | undefined,
  issuer: string,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  // RFC 9207 Section 2: include iss in success responses.
  url.searchParams.set('iss', issuer);
  return url.toString();
}`;
  return `/**
 * Authorization endpoint (API layer: logic only).
 * OIDC Core 1.0 Section 3.1.2
 *
 * Every function exported below is one box of the authorization endpoint's
 * pipeline (\`maronn-oidc graph --detail steps --endpoint authorize\`): parse the
 * request, resolve the client and the redirect_uri, validate the parameters,
 * create the transaction, verify id_token_hint, then try prompt=none and
 * Single Sign-On before continuing on the login screen.
 * processAuthorizationRequest() at the bottom calls them in order and reports
 * what the endpoint decided as an outcome: the authorization response URL for
 * the client, "continue on the login / consent screen", or an error that must
 * stay on the OP. It never builds a Response; pages/authorize.ts, which owns
 * GET|POST /authorize, turns the outcome into HTTP. A box that is left out of
 * a \`--flow\` document is left out of this file.
 */

/** What the authorization endpoint decided; pages/authorize.ts turns it into HTTP. */
export type AuthorizationOutcome =
  /** Malformed transport: OAuth error JSON (400), no transaction exists yet. */
  | { kind: 'bad_request'; error: string; errorDescription: string }
  /**
   * The authorization response for the client — code, redirectable error or
   * (EXPERIMENTAL JARM) signed response JWT — ready in the URL.
   */
  | { kind: 'authorization_response'; location: string }
  /**
   * Interactive authentication is needed: continue on the login screen. cookies
   * carries the transaction cookie, the only place the transaction id goes.
   */
  | { kind: 'login'; cookies: string[] }
  /** The End-User is signed in but consent is needed: continue on the consent screen. */
  | { kind: 'consent'; cookies: string[] }
  /** OIDC Core 1.0 §3.1.2.2: the error cannot be redirected and stays on the OP. */
  | { kind: 'error'; error: string; errorDescription?: string }
  /** An unexpected failure: OAuth error JSON (500). */
  | { kind: 'server_error' };

/**
 * The request parameters as parsed: the fields OIDC Core 1.0 §3.1.2.1 names,
 * plus every other parameter the client sent.
 */
export type AuthorizationRequestInput = AuthorizationRequestParams & Record<string, string>;

/** The transaction the pipeline created, with the lifetime its cookie gets. */
export interface AuthorizationTransaction {
  transactionId: string;
  transaction: AuthTransaction;
  transactionTtlSeconds: number;
}

/**
 * Narrows raw query-string params to the typed AuthorizationRequestParams.
 * PKCE parameters are validated by core so conformance compatibility mode can
 * intentionally pass requests that omit them.
 */
function isAuthorizationRequestParams(
  params: unknown,
): params is AuthorizationRequestParams {
  if (typeof params !== 'object' || params === null) return false;
  const p = params as Record<string, unknown>;
  return typeof p['client_id'] === 'string';
}

${redirectHelpers}

/**
 * Iterates URLSearchParams and reports the first repeated key, if any.
 * OIDC Core 1.0 §3.1.2.1 / RFC 6749 §3.1: authorization request parameters
 * MUST NOT be repeated. Object.fromEntries(searchParams) silently keeps the
 * last value, which would let \`response_type=code&response_type=token\` slip
 * through, so we scan entries explicitly.
 */
function collectUniqueParams(
  searchParams: URLSearchParams,
): { params: Record<string, string>; duplicateKey?: string } {
  const params: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, value] of searchParams) {
    if (seen.has(key)) {
      return { params, duplicateKey: key };
    }
    seen.add(key);
    params[key] = value;
  }
  return { params };
}

/**
 * OIDC Core 1.0 Section 3.1.2.1 / Section 13.2: parses the authorization request
 * parameters from either GET (query string) or POST (application/x-www-form-urlencoded).
 * Returns null if the request transport is invalid (e.g. unsupported Content-Type on POST).
 */
async function parseAuthorizationRequestParams(
  c: any,
): Promise<{ params: Record<string, string>; duplicateKey?: string } | null> {
  if (c.req.method === 'POST') {
    const contentType = c.req.header('Content-Type') ?? '';
    // OIDC Core 1.0 Section 13.2: POST must use application/x-www-form-urlencoded.
    if (!contentType.toLowerCase().split(';')[0].trim().startsWith('application/x-www-form-urlencoded')) {
      return null;
    }
    // Read the raw body so URLSearchParams preserves duplicate keys
    // (parseBody silently dedupes them).
    const raw = await c.req.text();
    return collectUniqueParams(new URLSearchParams(raw));
  }
  return collectUniqueParams(new URL(c.req.url).searchParams);
}`;
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

function parseRequestFragment(ctx: AuthorizeTemplateContext): StepFragment {
  // The PAR step replaces params with the pushed ones, so it needs a let.
  const binding = ctx.features.par ? 'let params = parsed.params;' : 'const params = parsed.params;';
  return {
    definition: `/**
 * Parse the authorization request (GET query or POST form).
 * OIDC Core 1.0 §3.1.2.1 / §13.2 / RFC 6749 §3.1
 *
 * Returns the bad_request outcome for malformed transport: a POST that is not
 * application/x-www-form-urlencoded, a repeated parameter, or no client_id.
 * There is no transaction yet, so those are answered as OAuth error JSON.
 */
export async function parseAuthorizationRequest(
  c: any,
): Promise<{ params: AuthorizationRequestInput } | AuthorizationOutcome> {
  const parsed = await parseAuthorizationRequestParams(c);

  if (parsed === null) {
    return { kind: 'bad_request', error: 'invalid_request', errorDescription: 'Authorization POST requests must use application/x-www-form-urlencoded' };
  }

  // OIDC Core 1.0 §3.1.2.1 / RFC 6749 §3.1: request parameters MUST NOT be repeated.
  if (parsed.duplicateKey !== undefined) {
    return { kind: 'bad_request', error: 'invalid_request', errorDescription: \`Parameter "\${parsed.duplicateKey}" must not be repeated\` };
  }

  const rawParams = parsed.params;

  if (!isAuthorizationRequestParams(rawParams)) {
    return { kind: 'bad_request', error: 'invalid_request', errorDescription: 'Missing required parameter: client_id' };
  }

  return { params: rawParams };
}`,
    call: `    const parsed = await parseAuthorizationRequest(c);
    if ('kind' in parsed) return parsed;
    ${binding}`,
  };
}

const RESOLVE_PUSHED_REQUEST: StepFragment = {
  imports: {
    store: ['parStore as defaultParStore'],
    modules: {
      [`${EXPERIMENTAL_PACKAGE}/par`]: ['PushedRequestUriError', 'assertPushedRequestUsed', 'resolvePushedRequestUri'],
      './par.js': ['parConfig'],
    },
  },
  definition: `/**
 * EXPERIMENTAL — Pushed Authorization Requests (RFC 9126 §4 / §5).
 *
 * Expands a request_uri of the form urn:ietf:params:oauth:request_uri:<ref>
 * into the parameters pushed to /par. The reference is single use and short
 * lived, so a reload of this URL fails with invalid_request_uri by design.
 * Anything that is not a URN (absent, or an OIDC Core §6.2 URL) is left to the
 * normal pipeline, which rejects it with request_uri_not_supported.
 *
 * Throws PushedRequestUriError, which authorizationErrorOutcome() keeps on the
 * OP: without a resolved request there is no verified redirect_uri.
 */
export async function resolvePushedAuthorizationRequest(
  c: any,
  params: AuthorizationRequestInput,
): Promise<AuthorizationRequestInput> {
  const parStore = c.get('parStore') ?? defaultParStore;
  // RFC 9126 §5: when require_pushed_authorization_requests is on, an
  // authorization request that did not go through /par is rejected outright.
  if (parConfig.requirePushedAuthorizationRequests) {
    assertPushedRequestUsed(params);
  }
  const pushedParams = await resolvePushedRequestUri({ params, store: parStore });
  if (pushedParams === null) return params;
  if (!isAuthorizationRequestParams(pushedParams)) {
    // Defensive: client_id was validated when the request was pushed.
    throw new PushedRequestUriError('invalid_request_uri', 'The request_uri is invalid, expired, or has already been used');
  }
  return pushedParams;
}`,
  call: `    params = await resolvePushedAuthorizationRequest(c, params);`,
};

const RESOLVE_CLIENT: StepFragment = {
  imports: {
    core: ['resolveClientForAuthorization', 'validateRegisteredRedirectUris', 'type ClientInfo'],
    resolvers: ['clientResolver as defaultClientResolver'],
  },
  definition: `/**
 * Resolve client_id into the registered client and fail fast on misconfigured
 * registered redirect URIs (fragments, dangerous schemes, non-loopback http).
 * OAuth 2.1 §4.1.2.1 / OIDC Core 1.0 §3.1.2.1 / RFC 8252 §8
 *
 * Errors thrown here are not redirectable: the OP has no redirect_uri it may
 * trust yet, so they stay on the OP (OIDC Core 1.0 §3.1.2.2).
 */
export async function resolveAuthorizationClient(
  c: any,
  params: AuthorizationRequestInput,
): Promise<ClientInfo> {
  const clientResolver = c.get('clientResolver') ?? defaultClientResolver;
  const client = await resolveClientForAuthorization(params, clientResolver);
  validateRegisteredRedirectUris(client.redirectUris);
  return client;
}`,
  call: { bind: 'client', expression: 'await resolveAuthorizationClient(c, params)' },
};

const RESOLVE_REQUEST_OBJECT: StepFragment = {
  imports: {
    core: ['resolveRequestObjectParams', 'type ClientInfo', 'type ResolvedRequestObjectParams'],
    resolvers: ['clientKeyResolver as defaultClientKeyResolver'],
  },
  definition: `/**
 * Verify the signed Request Object (request parameter) against the keys the
 * client registered for the request_object purpose and overlay its claims
 * onto the query parameters.
 * OIDC Core 1.0 §6.1 / §6.3.2
 *
 * RS256 is required; alg=none is accepted only when
 * config.allowUnsignedRequestObject is enabled (conformance compat).
 * effectiveParams is what every later step validates.
 */
export async function resolveRequestObject(
  c: any,
  params: AuthorizationRequestInput,
  client: ClientInfo,
): Promise<ResolvedRequestObjectParams> {
  const config = c.get('config');
  const clientKeyResolver = c.get('clientKeyResolver') ?? defaultClientKeyResolver;
  // The keys are read only for a request that carries a Request Object.
  const jwks = params.request === undefined
    ? undefined
    : await clientKeyResolver.findClientKeys(client.clientId, 'request_object');
  return resolveRequestObjectParams(params, { jwks, allowUnsigned: config.allowUnsignedRequestObject });
}`,
  call: {
    bind: ['effectiveParams', 'requestObjectClaims'],
    expression: 'await resolveRequestObject(c, params, client)',
  },
};

function resolveRedirectUriFragment(ctx: AuthorizeTemplateContext): StepFragment {
  return {
    imports: { core: ['resolveAuthorizationRedirectUri', 'type AuthorizationRequestParams', 'type ClientInfo'] },
    definition: `/**
 * Resolve redirect_uri against the registered URIs.
 * OIDC Core 1.0 §3.1.2.1 / RFC 6749 §4.1.2.1
 *
 * From here on an error is redirectable: it is sent to the client together
 * with the request's state. Everything before this step stays on the OP.
 */
export function resolveRedirectTarget(
  params: AuthorizationRequestParams,
  client: ClientInfo,
): { redirectUri: string; state: string | undefined } {
  const redirectUri = resolveAuthorizationRedirectUri(params, client);
  return { redirectUri, state: params.state };
}`,
    call: { bind: ['redirectUri', 'state'], expression: `resolveRedirectTarget(${ctx.effective}, client)` },
  };
}

function resolveJarmResponseModeFragment(ctx: AuthorizeTemplateContext): StepFragment {
  return {
    imports: {
      core: [
        'AuthorizationError',
        'AuthorizationErrorCode',
        'selectSigningKeyByAlg',
        'type AuthorizationRequestParams',
        'type ClientInfo',
        'type SigningKey',
      ],
      modules: { [`${EXPERIMENTAL_PACKAGE}/jarm`]: ['resolveJarmResponseMode'] },
    },
    definition: `/**
 * EXPERIMENTAL — JARM §2.3: interpret response_mode now that redirect_uri is
 * verified, so an unsupported JWT mode can be reported as a redirectable
 * error. Values outside the \`.jwt\` family stay ignored exactly as before, and
 * the result is undefined: the plain query response.
 */
export function resolveJarmResponseContext(
  c: any,
  params: AuthorizationRequestParams,
  client: ClientInfo,
  redirectUri: string,
  state: string | undefined,
  issuer: string,
): JarmResponseContext | undefined {
  const jarmResolution = resolveJarmResponseMode(params);
  if (jarmResolution.kind === 'unsupported-jwt-mode') {
    // JARM §2.3.2 / §2.3.3 (fragment.jwt / form_post.jwt) are not implemented
    // here. The rejection itself goes back as a PLAIN query error: the OP
    // cannot answer in a response mode it does not implement.
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidRequest,
      'response_mode ' + jarmResolution.requested + ' is not supported',
      redirectUri,
      state,
    );
  }
  if (jarmResolution.kind !== 'jarm') return undefined;
  // JARM §3: this OP declares alg RS256 on every response JWT (the default
  // for a client that registered no authorization_signed_response_alg), and
  // discovery advertises authorization_signing_alg_values_supported:
  // ['RS256']. The first key of the general-purpose set is not guaranteed to
  // be RS256 — a SigningKeyProvider may legitimately put an ES256 key first
  // in an RS256 + ES256 set — so the key is picked by alg from the set. Its
  // public half is published at /.well-known/jwks.json under the same kid.
  // selectSigningKeyByAlg throws when no RS256 key is registered, which
  // surfaces as a server_error here (a configuration mistake) rather than
  // as an unverifiable authorization response.
  const jarmSigningKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
  return {
    issuer,
    clientId: client.clientId,
    signingKey: selectSigningKeyByAlg(jarmSigningKeys, 'RS256'),
  };
}`,
    call: `    jarmResponse = resolveJarmResponseContext(c, ${ctx.effective}, client, redirectUri, state, issuer);`,
  };
}

function validateRequestFragment(ctx: AuthorizeTemplateContext): StepFragment {
  const { features, customScopes } = ctx;
  const effectiveField = features.requestObject
    ? `    /** The parameters after the Request Object overlay (OIDC Core 1.0 §6.1). */
    effectiveParams: AuthorizationRequestParams;
    requestObjectClaims: ResolvedRequestObjectParams['requestObjectClaims'];
`
    : '';
  const destructure = features.requestObject
    ? 'const { params, effectiveParams, requestObjectClaims, client, redirectUri, state } = input;'
    : 'const { params, client, redirectUri, state } = input;\n  const effectiveParams = params;';
  const rejectUnsupportedStep = features.requestObject
    ? `  // OIDC Core 1.0 §6.3: request_uri / registration are not supported here.
  rejectUnsupportedRequestParams(params, redirectUri, state);

  // OIDC Core 1.0 §6.1: response_type / client_id inside the Request Object
  // must match the OAuth query parameters.
  validateRequestObjectConsistency(params, requestObjectClaims, redirectUri, state);`
    : `  // OIDC Core 1.0 §6.3: request (disabled here) / request_uri / registration
  // are not supported and rejected explicitly.
  rejectUnsupportedRequestParams(params, redirectUri, state, {
    requestParameterSupported: false,
  });`;
  const offlineAccessStep = features.refreshToken
    ? `  // offline_access は 2 つの独立した条件を両方満たしたときだけ残る。
  // - OIDC Core 1.0 §11: エンドユーザーの同意（prompt=consent）
  // - RFC 7591 §2: クライアント登録の grant_types に refresh_token があること
  //   （既定は ["authorization_code"]）。無いまま offline_access を通すと、発行した
  //   Refresh Token が unauthorized_client で拒否されるだけの死んだ資格情報になる。
  // 独自の許可条件を差し込むならコールバックを渡す（client も受け取れる）:
  //   scope = await applyOfflineAccessPolicy(scope, effectiveParams, prompt, client,
  //     (req, { promptValues }) => promptValues.includes('consent') || hasStoredConsent(req));
  scope = await applyOfflineAccessPolicy(scope, effectiveParams, prompt, client);`
    : `  // The refresh_token feature is disabled in this generated provider:
  // the callback always returns false, so offline_access is never granted
  // (OIDC Core 1.0 §11 requires ignoring the request in that case).
  scope = await applyOfflineAccessPolicy(scope, effectiveParams, prompt, client, () => false);`;
  const customScopeStep = customScopes
    ? `

  // RFC 6749 §3.3 / §4.1.2.1: this provider was generated with a declared scope
  // allow list (scopes.ts), so a value outside it is rejected instead of being
  // carried into the grant. Placed AFTER applyOfflineAccessPolicy on purpose:
  // offline_access that the policy already dropped must stay "ignored"
  // (OIDC Core 1.0 §11) rather than turning the request into invalid_scope.
  const unsupportedScopes = findUnsupportedScopes(scope);
  if (unsupportedScopes.length > 0) {
    throw new AuthorizationError(
      AuthorizationErrorCode.InvalidScope,
      'Unsupported scope: ' + unsupportedScopes.join(' '),
      redirectUri,
      state,
    );
  }`
    : '';
  const callArgs = features.requestObject
    ? '{ params, effectiveParams, requestObjectClaims, client, redirectUri, state }'
    : '{ params, client, redirectUri, state }';
  return {
    imports: {
      core: [
        'rejectUnsupportedRequestParams',
        ...(features.requestObject ? ['validateRequestObjectConsistency'] : []),
        'validateResponseType',
        'validateAuthorizationScope',
        'validateClientScope',
        'validateAuthorizationCodePkce',
        'validatePromptParameter',
        'applyOfflineAccessPolicy',
        'validateDisplayParameter',
        'resolveMaxAge',
        'parseAudienceParameter',
        'parseClaimsRequestParameter',
        'validateAcrValuesParameter',
        ...(customScopes ? ['AuthorizationError', 'AuthorizationErrorCode'] : []),
        'type AuthorizationRequestParams',
        'type ClientInfo',
        ...(features.requestObject ? ['type ResolvedRequestObjectParams'] : []),
        'type ValidatedAuthorizationRequest',
      ],
      modules: customScopes ? { '../scopes.js': ['findUnsupportedScopes'] } : {},
    },
    definition: `/**
 * Validate the authorization request parameters and assemble the validated
 * request. OIDC Core 1.0 §3.1.2.1 - §3.1.2.2 / OAuth 2.1 §4.1.1 / §7.5
 *
 * Each check is an independent core function, called in OIDC Core 1.0 §3.1.2
 * order. Delete a call to drop that validation, or insert your own logic
 * between two checks. Every failure here is redirectable (sent to the client
 * with the state), because redirect_uri was resolved before this step.
 */
export async function validateAuthorizationRequestParams(
  c: any,
  input: {
    /** The parameters as sent (OAuth query parameters). */
    params: AuthorizationRequestInput;
${effectiveField}    client: ClientInfo;
    redirectUri: string;
    state: string | undefined;
  },
): Promise<ValidatedAuthorizationRequest> {
  ${destructure}
  const config = c.get('config');

${rejectUnsupportedStep}

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

  // OIDC Core 1.0 §3.1.2.1: acr_values is optional, space-separated acr values
  // in order of preference, each of visible ASCII characters other than " and \\.
  // The token endpoint puts the acr it settles on into the ID Token and the
  // access token (routes/token.ts).
  const acrValues = validateAcrValuesParameter(effectiveParams, redirectUri, state);

  // Assemble the validated request from each step's result. This is core's
  // ValidatedAuthorizationRequest (what createAuthTransaction() takes), so
  // downstream code (transactions, authorization codes) is unaffected by
  // adding or removing steps above.
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
    acrValues,
    loginHint: effectiveParams.login_hint,
    idTokenHint: effectiveParams.id_token_hint,
    audience,
    claims,
  };
  return validatedRequest;
}`,
    call: {
      bind: 'validatedRequest',
      expression: `await validateAuthorizationRequestParams(c, ${callArgs})`,
    },
  };
}

function createTransactionFragment(ctx: AuthorizeTemplateContext): StepFragment {
  const jarm = ctx.features.jarm;
  return {
    imports: {
      core: ['createAuthTransaction', 'generateRandomString', 'type AuthTransaction', 'type ValidatedAuthorizationRequest'],
      store: ['transactionStore as defaultTransactionStore'],
    },
    definition: `/**
 * Create the authorization transaction and store it for the login / consent
 * steps. OIDC Core 1.0 §3.1.2.3
 *
 * csrfToken is embedded in the login / consent forms; transactionId never
 * leaves the OP except in the HttpOnly transaction cookie
 * (buildTransactionCookie() in store.ts).${
   jarm
     ? `
 *
 * EXPERIMENTAL (JARM): the requested response mode is recorded on the stored
 * transaction so the consent route — which only ever sees the transaction it
 * reads back — answers in the same mode. The store MUST persist unknown fields.`
     : ''
 }
 */
export async function createAuthorizationTransaction(
  c: any,
  validatedRequest: ValidatedAuthorizationRequest${jarm ? ',\n  jarmResponse: JarmResponseContext | undefined' : ''},
): Promise<AuthorizationTransaction> {
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const csrfToken = await generateRandomString(32);
  const transaction: AuthTransaction = createAuthTransaction(validatedRequest, csrfToken);
  const transactionId = await generateRandomString(32);

  const transactionTtlSeconds = 10 * 60; // 10 minutes TTL
  await transactionStore.put(
    'auth_txn:' + transactionId,
    ${jarm ? "jarmResponse ? { ...transaction, jarmResponseMode: 'query.jwt' } : transaction" : 'transaction'},
    transactionTtlSeconds,
  );
  return { transactionId, transaction, transactionTtlSeconds };
}`,
    call: {
      bind: ['transactionId', 'transaction', 'transactionTtlSeconds'],
      expression: `await createAuthorizationTransaction(c, validatedRequest${jarm ? ', jarmResponse' : ''})`,
    },
  };
}

function rejectCombinedPromptNoneFragment(ctx: AuthorizeTemplateContext): StepFragment {
  return {
    imports: { core: ['type AuthTransaction'], store: ['transactionStore as defaultTransactionStore'] },
    definition: `/**
 * OIDC Core 1.0 §3.1.2.1: prompt=none must not be combined with other values.
 * Returns the redirectable error outcome (and drops the transaction) when it
 * is; undefined otherwise.
 */
export async function rejectCombinedPromptNone(
  c: any,
  promptValues: string[],
  transactionId: string,
  transaction: AuthTransaction,
  issuer: string${ctx.jarmParam},
): Promise<AuthorizationOutcome | undefined> {
  if (!(promptValues.includes('none') && promptValues.length > 1)) return undefined;
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  await transactionStore.delete('auth_txn:' + transactionId);
  return {
    kind: 'authorization_response',
    location: ${ctx.awaitKw}buildErrorRedirect(${ctx.jarmArg}transaction.redirectUri, 'invalid_request', transaction.state, 'prompt=none must not be combined with other prompt values', issuer),
  };
}`,
    call: {
      before: `    // OIDC Core 1.0 Section 3.1.2.1: prompt is a space-delimited list
    const promptValues = transaction.prompt?.trim().split(/\\s+/).filter(Boolean) ?? [];
    const promptCombinationError = await rejectCombinedPromptNone(c, promptValues, transactionId, transaction, issuer${ctx.jarmCallArg});
    if (promptCombinationError) return promptCombinationError;`,
      bind: [],
      expression: '',
    },
  };
}

function verifyIdTokenHintFragment(ctx: AuthorizeTemplateContext): StepFragment {
  return {
    imports: {
      core: ['validateIdTokenHint', 'IdTokenHintError', 'type AuthTransaction', 'type JwkSet'],
      store: ['transactionStore as defaultTransactionStore'],
    },
    definition: `/**
 * Verify id_token_hint: signature, iss, aud, exp and iat against the OP's own
 * JWKS. OIDC Core 1.0 §3.1.2.1
 *
 * The rule ("if the End-User identified by the ID Token is logged in ...
 * otherwise it SHOULD return an error") is NOT conditioned on prompt, so the
 * hint is verified on every prompt path (no prompt / login / consent /
 * select_account / none). The verified subject is shared by the prompt=none
 * check and by the SSO fast path, so an unverified hint never reaches a
 * session decision. A hint that does not verify is a redirectable error
 * (login_required, or the hint's own code), and the transaction is dropped.
 */
export async function verifyIdTokenHint(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
  issuer: string${ctx.jarmParam},
): Promise<{ verifiedHintSubject: string | undefined } | AuthorizationOutcome> {
  if (transaction.idTokenHint === undefined) return { verifiedHintSubject: undefined };
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const jwksProvider = c.get('jwksProvider') as undefined | (() => Promise<JwkSet> | JwkSet);
  if (!jwksProvider) {
    // jwksProvider 未提供では hint を検証できない → login_required で拒否
    await transactionStore.delete('auth_txn:' + transactionId);
    return {
      kind: 'authorization_response',
      location: ${ctx.awaitKw}buildErrorRedirect(${ctx.jarmArg}transaction.redirectUri, 'login_required', transaction.state, 'jwksProvider is not configured; cannot verify id_token_hint', issuer),
    };
  }
  try {
    const jwks = await jwksProvider();
    const verified = await validateIdTokenHint(transaction.idTokenHint, {
      expectedIss: issuer,
      expectedAud: transaction.clientId,
      jwks,
    });
    return { verifiedHintSubject: verified.sub };
  } catch (hintError) {
    await transactionStore.delete('auth_txn:' + transactionId);
    const code = hintError instanceof IdTokenHintError ? hintError.error : 'login_required';
    return {
      kind: 'authorization_response',
      location: ${ctx.awaitKw}buildErrorRedirect(${ctx.jarmArg}transaction.redirectUri, code, transaction.state, hintError instanceof Error && hintError.message ? hintError.message : 'id_token_hint verification failed', issuer),
    };
  }
}`,
    call: {
      before: `    const hint = await verifyIdTokenHint(c, transactionId, transaction, issuer${ctx.jarmCallArg});
    if ('kind' in hint) return hint;`,
      bind: ['verifiedHintSubject'],
      expression: 'hint',
    },
    otherwise: { verifiedHintSubject: 'const verifiedHintSubject: string | undefined = undefined;' },
  };
}

function authenticateSilentlyFragment(ctx: AuthorizeTemplateContext): StepFragment {
  const scopePolicy = ctx.customScopes
    ? `

    // Apply the scope policy BEFORE the consent lookup: searching consent for
    // a scope this End-User can never hold would answer consent_required
    // forever (OIDC Core 1.0 §3.1.2.1). See resolveGrantableScopes() in
    // scopes.ts — that function is where per-user filtering is written.
    transaction.scope = (await resolveGrantableScopes(
      transaction.scope.split(' ').filter(Boolean),
      session.subject,
    )).join(' ');`
    : '';
  return {
    imports: {
      core: [
        'resolvePromptNoneSession',
        'validatePromptNoneIdTokenHint',
        'validatePromptNoneConsent',
        'requiresReauthentication',
        'AuthorizationError',
        'type AuthTransaction',
        'type SessionInfo',
      ],
      store: ['transactionStore as defaultTransactionStore'],
      modules: ctx.customScopes ? { '../scopes.js': ['resolveGrantableScopes'] } : {},
    },
    definition: `/**
 * prompt=none: silent authentication without any user interaction.
 * OIDC Core 1.0 §3.1.2.1
 *
 * Returns undefined when the request did not ask for prompt=none (the
 * pipeline goes on to SSO and the login screen). Otherwise the session the
 * code is issued for, or the redirectable error (login_required /
 * consent_required / server_error) and the transaction is dropped: the OP
 * must not show a login or consent screen for prompt=none.
 */
export async function completePromptNoneRequest(
  c: any,
  input: {
    promptValues: string[];
    transactionId: string;
    transaction: AuthTransaction;
    verifiedHintSubject: string | undefined;
    issuer: string;${ctx.features.jarm ? '\n    jarmResponse: JarmResponseContext | undefined;' : ''}
  },
): Promise<{ session: SessionInfo } | AuthorizationOutcome | undefined> {
  const { promptValues, transactionId, transaction, verifiedHintSubject, issuer${ctx.features.jarm ? ', jarmResponse' : ''} } = input;
  if (!promptValues.includes('none')) return undefined;

  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const sessionResolver = c.get('sessionResolver');
  const consentResolver = c.get('consentResolver');
  const errorResponse = async (error: string, description: string): Promise<AuthorizationOutcome> => {
    await transactionStore.delete('auth_txn:' + transactionId);
    return {
      kind: 'authorization_response',
      location: ${ctx.awaitKw}buildErrorRedirect(${ctx.jarmArg}transaction.redirectUri, error, transaction.state, description, issuer),
    };
  };

  // No sessionResolver configured → cannot verify session → login_required
  if (!sessionResolver) {
    return errorResponse('login_required', 'sessionResolver is not configured; cannot satisfy prompt=none');
  }

  // No consentResolver configured → cannot confirm consent → consent_required
  // (OIDC Core 1.0 Section 3.1.2.1: prompt=none must not display consent screen)
  if (!consentResolver) {
    return errorResponse('consent_required', 'consentResolver is not configured; cannot satisfy prompt=none');
  }

  let session: SessionInfo;
  try {
    // --- prompt=none pipeline ---------------------------------------
    // Each step below is an independent core function: the session, then
    // id_token_hint (before consent, so consent is never looked up for
    // another End-User), then consent. Delete a call to drop that check,
    // or insert your own logic between steps. Every step throws
    // AuthorizationError(login_required | consent_required) on failure.

    // OIDC Core 1.0 §3.1.2.1: no active session → login_required (the OP
    // must not show a login screen for prompt=none).
    session = await resolvePromptNoneSession(transaction, sessionResolver, c.req.raw);

    // verifiedHintSubject は上流（prompt 非依存の検証ブロック）で確定済み。
    // ここでは prompt=none 固有の「不一致なら login_required」判定だけを行う。
    // コンセント確認より前に置くのは、コンセント検索が session.subject をキーに
    // するため — 不一致のまま進むと別ユーザーのコンセントを見てしまう。
    validatePromptNoneIdTokenHint(transaction, session, verifiedHintSubject);${scopePolicy}

    // OIDC Core 1.0 §3.1.2.1: not consented → consent_required (the OP must
    // not show a consent screen for prompt=none).
    await validatePromptNoneConsent(transaction, session, consentResolver);
  } catch (promptError) {
    if (promptError instanceof AuthorizationError) {
      return errorResponse(promptError.error, promptError.errorDescription ?? '');
    }
    const serverDescription =
      promptError instanceof Error && promptError.message
        ? promptError.message
        : 'Unexpected error while evaluating prompt=none';
    return errorResponse('server_error', serverDescription);
  }

  // Check max_age: if session is too old, prompt=none cannot trigger re-authentication
  // OIDC Core 1.0 Section 3.1.2.1
  if (transaction.maxAge !== undefined && requiresReauthentication(transaction.maxAge, session.authTime)) {
    return errorResponse('login_required', 'Session exceeds the requested max_age; re-authentication required');
  }

  return { session };
}`,
    call: `    const silent = await completePromptNoneRequest(c, { promptValues, transactionId, transaction, verifiedHintSubject, issuer${ctx.jarmCallArg} });
    if (silent !== undefined) {
      if ('kind' in silent) return silent;
      return issueAuthorizationCodeResponse(c, { transactionId, transaction, session: silent.session, issuer${ctx.jarmCallArg} });
    }`,
  };
}

function reuseSessionFragment(ctx: AuthorizeTemplateContext): StepFragment {
  const scopePolicy = ctx.customScopes
    ? `
  // Apply the scope policy before the consent lookup below, for the same
  // reason as the prompt=none path. The narrowed value is only held in
  // memory: the interactive branch hands the transaction back to
  // /consent, which applies the policy again with the authenticated
  // subject it reads out of authSessionStore.
  transaction.scope = (await resolveGrantableScopes(
    transaction.scope.split(' ').filter(Boolean),
    existingSession.subject,
  )).join(' ');
`
    : '';
  return {
    imports: {
      core: ['requiresReauthentication', 'type AuthTransaction', 'type SessionInfo'],
      store: ['authSessionStore as defaultAuthSessionStore', 'buildTransactionCookie'],
      modules: ctx.customScopes ? { '../scopes.js': ['resolveGrantableScopes'] } : {},
    },
    definition: `/**
 * Single Sign-On: reuse the active OP session instead of showing the login
 * screen. OIDC Core 1.0 §3.1.2.3
 *
 * - prompt=login / prompt=select_account always force re-authentication.
 * - When max_age is requested, the session must also satisfy the freshness
 *   bound (§3.1.2.1); when it is absent, any active session is reused.
 * - The session must belong to the End-User id_token_hint names (§3.1.2.1):
 *   otherwise the request falls to the login screen rather than silently
 *   issuing a code for another End-User.
 *
 * Returns undefined when there is no session to reuse (continue on the login
 * screen); the session when consent was already granted (the code is issued);
 * or the consent outcome when the End-User still has to decide (prompt=consent
 * MUST re-display the consent UI).
 */
export async function reuseExistingSession(
  c: any,
  input: {
    promptValues: string[];
    transactionId: string;
    transaction: AuthTransaction;
    transactionTtlSeconds: number;
    verifiedHintSubject: string | undefined;
  },
): Promise<{ session: SessionInfo } | AuthorizationOutcome | undefined> {
  const { promptValues, transactionId, transaction, transactionTtlSeconds, verifiedHintSubject } = input;
  if (promptValues.includes('login') || promptValues.includes('select_account')) return undefined;
  const sessionResolver = c.get('sessionResolver');
  if (!sessionResolver) return undefined;

  const existingSession = await sessionResolver.resolve(c.req.raw);
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
  if (!existingSession || !sessionIsFresh || !hintMatchesSession) return undefined;

  // OIDC Core 1.0 §3.1.2.1: prompt=consent MUST re-display the consent UI.
  // Otherwise, if the user already granted (a superset of) the requested
  // scopes to this client, skip the consent screen and issue the code
  // directly — the interactive analogue of the prompt=none silent path.
  const consentResolver = c.get('consentResolver');
${scopePolicy}  const requestedScopes = transaction.scope.split(' ').filter(Boolean);
  const consentAlreadyGranted =
    !promptValues.includes('consent') &&
    consentResolver !== undefined &&
    (await consentResolver.hasConsent(
      existingSession.subject,
      transaction.clientId,
      requestedScopes,
    ));
  if (consentAlreadyGranted) {
    return { session: existingSession };
  }

  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  await authSessionStore.set(transactionId, {
    subject: existingSession.subject,
    authTime: existingSession.authTime,
    // consent 画面を経由しても online refresh token の束縛先を見失わないよう、
    // login → consent の受け渡しに sessionId も載せる。
    sessionId: existingSession.sessionId,
  });
  // Continue on the consent screen (pages/consent.ts), which finds the
  // transaction through the cookie that travels with this answer.
  return {
    kind: 'consent',
    cookies: [buildTransactionCookie(transactionId, transactionTtlSeconds)],
  };
}`,
    call: `    const sso = await reuseExistingSession(c, { promptValues, transactionId, transaction, transactionTtlSeconds, verifiedHintSubject });
    if (sso !== undefined) {
      if ('kind' in sso) return sso;
      return issueAuthorizationCodeResponse(c, { transactionId, transaction, session: sso.session, issuer${ctx.jarmCallArg} });
    }`,
  };
}

function issueAuthorizationCodeFragment(ctx: AuthorizeTemplateContext): StepFragment {
  return {
    imports: {
      core: ['completeAuthTransaction', 'createAuthorizationCode', 'type AuthTransaction', 'type SessionInfo'],
      store: ['transactionStore as defaultTransactionStore', 'authCodeStore as defaultAuthCodeStore'],
    },
    definition: `/**
 * Issue the authorization code for a session that needs no interaction
 * (prompt=none, or SSO with prior consent) and build the authorization
 * response URL. OIDC Core 1.0 §3.1.2.5 / §3.1.3.1 / RFC 9207 §2
 *
 * transaction.scope は認可リクエスト検証時に applyOfflineAccessPolicy を通した
 * 後の値。offline_access の可否（OIDC Core 1.0 §11 の prompt=consent と、
 * クライアント登録 grant_types に refresh_token があるか）はそこで判定済みなので、
 * ここで再フィルタしない。
 */
export async function issueAuthorizationCodeResponse(
  c: any,
  input: {
    transactionId: string;
    transaction: AuthTransaction;
    session: SessionInfo;
    issuer: string;${ctx.features.jarm ? '\n    jarmResponse: JarmResponseContext | undefined;' : ''}
  },
): Promise<AuthorizationOutcome> {
  const { transactionId, transaction, session, issuer${ctx.features.jarm ? ', jarmResponse' : ''} } = input;
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const authCodeStore = c.get('authCodeStore') ?? defaultAuthCodeStore;
  const consentResolver = c.get('consentResolver');
  const config = c.get('config');

  const grantedScope = transaction.scope.split(' ').filter(Boolean);

  // Generate authorization code via core helper
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
  await consentResolver?.recordGrant?.(
    session.subject,
    transaction.clientId,
    authCodeData.grantId,
  );

  return {
    kind: 'authorization_response',
    location: ${ctx.awaitKw}buildSuccessRedirect(
      ${ctx.jarmArg}transaction.redirectUri,
      authCodeData.code,
      transaction.state,
      issuer,
    ),
  };
}`,
    // Called from completePromptNoneRequest's and reuseExistingSession's statements.
    call: '',
  };
}

const CONTINUE_TO_LOGIN: StepFragment = {
  imports: { store: ['buildTransactionCookie'] },
  definition: `/**
 * Interactive authentication: continue on the login screen (pages/login.ts;
 * prompt=login forces re-authentication there), which finds the transaction
 * through the cookie that travels with this answer. OIDC Core 1.0 §3.1.2.3
 */
export function continueToLogin(transactionId: string, transactionTtlSeconds: number): AuthorizationOutcome {
  return { kind: 'login', cookies: [buildTransactionCookie(transactionId, transactionTtlSeconds)] };
}`,
  call: `    return continueToLogin(transactionId, transactionTtlSeconds);`,
};

function respondErrorFragment(ctx: AuthorizeTemplateContext): StepFragment {
  const parBranch = ctx.features.par
    ? `  if (error instanceof PushedRequestUriError) {
    // RFC 9126 §4 / OIDC Core 1.0 §3.1.2.6: a request_uri that cannot be
    // resolved leaves us without a verified redirect_uri, so this error is
    // NEVER redirected (RFC 6749 §4.1.2.1). It is rendered through the same
    // non-redirect path as AuthorizationError below. Every failure kind
    // (unknown / used / expired / wrong client) returns the identical code and
    // description so the response cannot be used as an existence oracle.
    return { kind: 'error', error: error.code, errorDescription: error.errorDescription };
  }
`
    : '';
  return {
    imports: {
      core: ['AuthorizationError'],
      modules: ctx.features.par ? { [`${EXPERIMENTAL_PACKAGE}/par`]: ['PushedRequestUriError'] } : {},
    },
    definition: `/**
 * Map a failure of any step to the outcome: a redirectable error goes back to
 * the client with the state and iss (RFC 9207 §2); an error thrown before the
 * redirect_uri was verified stays on the OP (OIDC Core 1.0 §3.1.2.2: unknown
 * client_id, unregistered redirect_uri, redirect_uri with a fragment);
 * anything else is a server_error.${
   ctx.features.jarm
     ? `
 *
 * EXPERIMENTAL (JARM §2.1): when this request asked for a JWT response mode,
 * the error members become claims of a signed JWT and no plain parameter is
 * added. jarmResponse is undefined for errors thrown before response_mode was
 * interpreted (unknown client, unsupported JWT mode), which is why those stay plain.`
     : ''
 }
 */
export async function authorizationErrorOutcome(
  c: any,
  error: unknown${ctx.jarmParam},
): Promise<AuthorizationOutcome> {
${parBranch}  if (error instanceof AuthorizationError) {
    if (error.redirectUri) {
      return {
        kind: 'authorization_response',
        location: ${ctx.awaitKw}buildErrorRedirect(
          ${ctx.jarmArg}error.redirectUri,
          error.error,
          error.state,
          error.errorDescription,
          c.get('config').issuer,
        ),
      };
    }
    // OIDC Core 1.0 §3.1.2.2: errors that cannot be redirected MUST NOT
    // redirect to the supplied redirect_uri. They stay on the OP:
    // pages/authorize.ts answers programmatic callers (Accept:
    // application/json) with the OAuth error JSON and browsers with the OP's
    // own error page.
    return { kind: 'error', error: error.error, errorDescription: error.errorDescription };
  }
  return { kind: 'server_error' };
}`,
    call: '',
  };
}

function authorizeFragments(ctx: AuthorizeTemplateContext): Record<string, StepFragment> {
  return {
    'parse-request': parseRequestFragment(ctx),
    'resolve-pushed-request': RESOLVE_PUSHED_REQUEST,
    'resolve-client': RESOLVE_CLIENT,
    'resolve-request-object': RESOLVE_REQUEST_OBJECT,
    'resolve-redirect-uri': resolveRedirectUriFragment(ctx),
    'resolve-jarm-response-mode': resolveJarmResponseModeFragment(ctx),
    'validate-request': validateRequestFragment(ctx),
    'create-transaction': createTransactionFragment(ctx),
    'validate-prompt-combination': rejectCombinedPromptNoneFragment(ctx),
    'verify-id-token-hint': verifyIdTokenHintFragment(ctx),
    'authenticate-silently': authenticateSilentlyFragment(ctx),
    'reuse-session': reuseSessionFragment(ctx),
    'issue-authorization-code': issueAuthorizationCodeFragment(ctx),
    'continue-to-login': CONTINUE_TO_LOGIN,
    'respond-error': respondErrorFragment(ctx),
  };
}

/**
 * The generated `routes/authorize.ts`. `steps` is the `--flow` selection for
 * the authorize endpoint (default: the catalog's steps, in order).
 */
export function authorizeRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
  steps?: string[],
): string {
  const ctx = templateContext(features, scopes);
  const endpoint = buildOpFlow({ features, scopes }).endpoints.find((e) => e.id === 'authorize');
  if (endpoint === undefined) throw new Error('The flow catalog has no authorize endpoint');
  const jarmHeaderImports: { core: string[]; modules: Record<string, string[]> } = features.jarm
    ? {
        core: ['sanitizeErrorDescription', 'type SigningKey'],
        modules: {
          [`${EXPERIMENTAL_PACKAGE}/jarm`]: ['buildJarmRedirectUrl', 'createJarmResponseJwt'],
          './jarm.js': ['jarmConfig'],
        },
      }
    : { core: ['sanitizeErrorDescription'], modules: {} };
  return renderPipelineRoute({
    endpoint,
    fragments: authorizeFragments(ctx),
    ...(steps === undefined ? {} : { selection: steps }),
    corePkg,
    fixedImports: {
      core: ['type AuthorizationRequestParams', 'type AuthTransaction', ...jarmHeaderImports.core],
      modules: jarmHeaderImports.modules,
    },
    header: authorizeHeader(ctx),
    handlerOpen: `/**
 * Process one authorization request (OIDC Core 1.0 Section 3.1.2). Shared by
 * GET and POST /authorize (pages/authorize.ts).
 *
 * The pipeline: each statement below is one step function of this module, in
 * the order of the flow. A step that throws ends in authorizationErrorOutcome().
 */
export async function processAuthorizationRequest(c: any): Promise<AuthorizationOutcome> {${
      features.jarm
        ? `
  // EXPERIMENTAL — JARM §2.3. Set once redirect_uri is verified; undefined means
  // the plain query response. Declared before the try block so the catch can
  // answer in the mode the request asked for.
  let jarmResponse: JarmResponseContext | undefined;`
        : ''
    }
  try {
    // RFC 9207 §2: include the issuer identifier on every authorization
    // response (success and error) so clients can pin the issuer that
    // produced the response.
    const issuer: string = c.get('config').issuer;
`,
    handlerClose: `  } catch (error) {
    return authorizationErrorOutcome(c, error${features.jarm ? ', jarmResponse' : ''});
  }
}
`,
  });
}
