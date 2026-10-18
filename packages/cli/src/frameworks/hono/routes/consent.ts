/**
 * The consent screen's logic (routes/consent.ts) as the step functions of the
 * `consent` endpoint of the flow catalog (flow/catalog.ts).
 *
 * The endpoint has a fixed sequence of steps: the screen's GET and POST decide
 * the order, so a `--flow` document cannot rearrange them, and this module is
 * written out instead of being assembled by pipeline.ts. Every step is still
 * one exported function named as in the catalog, so one box of
 * `maronn-oidc graph --detail steps --endpoint consent` is one function of the
 * generated file; prepareConsent() and submitConsent() run them in the order
 * the screen needs.
 */
import { DEFAULT_FEATURES } from '../../../registry.js';
import type { OidcFeatureConfig } from '../../../registry.js';
import { EXPERIMENTAL_PACKAGE } from '../../packages.js';

export function consentRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
): string {
  // The consent step is where the interactive flow turns the requested scope into
  // a granted one, and it is the first step that knows who the End-User is, so it
  // is where the scope policy (scopes.ts) is applied — both to what the screen
  // shows and to what is granted. With no custom scope declared every
  // interpolation below is empty.
  const customScopesDeclared = scopes.length > 0;
  const customScopeImports = customScopesDeclared
    ? `
import { resolveGrantableScopes } from '../scopes.js';`
    : '';
  const consentGetScopeResolution = customScopesDeclared
    ? `  // Describe only what THIS End-User can actually grant. The subject comes
  // from the auth session that /login (or the SSO fast path) stored for this
  // transaction; without one there is nothing to apply the policy to, so the
  // request is shown as-is and submitConsent() stops on the same missing session.
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  const consentSession = await authSessionStore.get(transactionId);
  const requestedScopes = transaction.scope.split(' ').filter(Boolean);
  const displayedScopes = consentSession
    ? await resolveGrantableScopes(requestedScopes, consentSession.subject)
    : requestedScopes;

`
    : '';
  // Only the scope policy needs the request context and the transaction id (the
  // auth session is keyed by it); keep the plain helper free of unused
  // parameters so strict generated projects still compile.
  const screenContextParam = customScopesDeclared ? '  c: any,\n  transactionId: string,\n' : '';
  const screenContextArg = customScopesDeclared ? 'c, transactionId, ' : '';
  const consentPrepareBindings = customScopesDeclared ? 'transactionId, transaction' : 'transaction';
  const consentDisplayScopes = customScopesDeclared
    ? 'displayedScopes'
    : "transaction.scope.split(' ').filter(Boolean)";
  const consentGrantedScope = customScopesDeclared
    ? `  // Apply the scope policy (resolveGrantableScopes in scopes.ts — the place to
  // write per-user filtering). A dropped scope narrows the grant rather than
  // failing the request: RFC 6749 §3.3 lets the authorization server issue a
  // narrower scope, and the token response reports what was granted.
  const grantedScope = await resolveGrantableScopes(
    transaction.scope.split(' ').filter(Boolean),
    session.subject,
  );`
    : `  const grantedScope = transaction.scope.split(' ').filter(Boolean);`;
  // EXPERIMENTAL (JARM): the consent step is where the interactive flow produces
  // its authorization response, so it must answer in the mode the authorize step
  // recorded on the transaction. Every interpolation collapses to the plain
  // query response when the jarm feature is off.
  const jarmConsentImports = features.jarm
    ? `
import {
  buildJarmRedirectUrl,
  createJarmResponseJwt,
  type JarmAuthTransactionFields,
} from '${EXPERIMENTAL_PACKAGE}/jarm';
import { jarmConfig } from './jarm.js';`
    : '';
  const jarmConsentCoreImports = features.jarm
    ? `
  selectSigningKeyByAlg,
  type SigningKey,`
    : '';
  const jarmConsentHelpers = features.jarm
    ? `
/**
 * EXPERIMENTAL — JARM (JWT Secured Authorization Response Mode).
 *
 * The authorize step recorded the requested response mode on the transaction
 * (jarmResponseMode). This step only ever sees the transaction it read back
 * from the store, so the auth transaction store MUST persist fields it does not
 * know about — otherwise a client that asked for a JWT response silently gets a
 * plain query response instead.
 */
function resolveJarmResponse(
  c: any,
  transaction: AuthTransaction & JarmAuthTransactionFields,
): JarmResponseContext | undefined {
  if (transaction.jarmResponseMode !== 'query.jwt') return undefined;
  // JARM Section 3: the response JWT always declares alg RS256, so the key is
  // picked by alg from the registered key set rather than taken as its first
  // key, which the SigningKeyProvider contract does not guarantee to be RS256.
  // Its public half is published at /.well-known/jwks.json under the same kid.
  const jarmSigningKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
  return {
    issuer: c.get('config').issuer,
    clientId: transaction.clientId,
    signingKey: selectSigningKeyByAlg(jarmSigningKeys, 'RS256'),
  };
}

type JarmResponseContext = {
  issuer: string;
  clientId: string;
  signingKey: SigningKey;
};
`
    : '';
  // The transaction is over once a decision is recorded: its cookie travels back
  // cleared so the browser does not keep pointing at a finished transaction.
  const finishedCookies = '[buildClearedTransactionCookie()]';
  const buildConsentRedirect = features.jarm
    ? `/**
 * [build-authorization-response] Build the authorization response for the
 * client. EXPERIMENTAL — JARM §2.3.1: when the authorize step recorded
 * response_mode=query.jwt on the transaction, the response is delivered as the
 * single \\\`response\\\` query parameter holding a signed JWT (its iss claim
 * carries the RFC 9207 statement, so no plain iss parameter is added).
 * Otherwise it is the plain query response the OP has always produced, with
 * RFC 9207 §2 iss appended so clients can pin the issuer that produced it.
 */
export async function buildConsentRedirect(
  c: any,
  transaction: AuthTransaction,
  redirectUri: string,
  parameters: Record<string, string | undefined>,
  issuer: string,
): Promise<ConsentOutcome> {
  const jarm = resolveJarmResponse(c, transaction);
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
    return { kind: 'authorization_response', location, cookies: ${finishedCookies} };
  }
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    if (value) url.searchParams.set(name, value);
  }
  url.searchParams.set('iss', issuer);
  return { kind: 'authorization_response', location: url.toString(), cookies: ${finishedCookies} };
}`
    : `/**
 * [build-authorization-response] Build the authorization response for the
 * client: its redirect_uri with the parameters, plus RFC 9207 §2 iss so
 * clients can pin the issuer that produced the response.
 */
export function buildConsentRedirect(
  redirectUri: string,
  parameters: Record<string, string | undefined>,
  issuer: string,
): ConsentOutcome {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    if (value) url.searchParams.set(name, value);
  }
  url.searchParams.set('iss', issuer);
  return { kind: 'authorization_response', location: url.toString(), cookies: ${finishedCookies} };
}`;
  // With JARM the response builder needs the request context (signing keys) and
  // the transaction (the recorded response mode).
  const redirectContextArgs = features.jarm ? 'c, transaction, ' : '';
  const denyJarmNote = features.jarm
    ? `
  // EXPERIMENTAL (JARM §2.1): a request that asked for response_mode=query.jwt
  // gets its error as a signed JWT too, so the client can verify that the OP
  // it trusts is the one that denied the request.`
    : '';
  return `/**
 * Consent step (API layer: logic only).
 *
 * Everything the consent screen has to decide lives here as plain functions,
 * one per box of \`maronn-oidc graph --detail steps --endpoint consent\`:
 * finding the transaction through the transaction cookie (loadTransaction),
 * the csrf_token check (validateConsentCsrfToken), the scope policy and the
 * form (describeConsentScreen), the authorization decision
 * (validateConsentDecision, denyAuthorizationRequest), the authorization code
 * (issueConsentedAuthorizationCode), the consent record
 * (recordConsentDecision) and the authorization response URL
 * (buildConsentRedirect: RFC 6749 §4.1.2 / RFC 9207 iss / JARM). None of them
 * builds a Response — each returns an outcome, and pages/consent.ts turns that
 * outcome into a screen or a redirect. prepareConsent() (GET) and
 * submitConsent() (POST) run them in the order the screen needs, so the UI can
 * be changed without touching this file.
 */
import {
  getAuthTransaction,
  validateCsrfToken,
  completeAuthTransaction,
  createAuthorizationCode,
  AuthTransactionError,
  type AuthTransaction,
  type AuthorizationCodeData,
  type AuthorizationResponseParams,${jarmConsentCoreImports}
} from '${corePkg}';
import {
  consentResolver as defaultConsentResolver,
} from '../resolvers.js';
import {
  transactionStore as defaultTransactionStore,
  authCodeStore as defaultAuthCodeStore,
  authSessionStore as defaultAuthSessionStore,
  buildClearedTransactionCookie,
  parseTransactionId,
  isSameOriginFormPost,
  CROSS_ORIGIN_FORM_POST_MESSAGE,
  type AuthSessionInfo,
} from '../store.js';${jarmConsentImports}${customScopeImports}

/** What the consent form needs, prepared for GET /consent. */
export interface ConsentScreen {
  kind: 'screen';
  /**
   * Must be posted back as the csrf_token field. It is the only value the form
   * carries about the transaction: the transaction itself travels in the
   * transaction cookie, and POST /consent accepts the token only for that one.
   */
  csrfToken: string;
  /** Scopes this End-User is asked to grant (already narrowed by the scope policy). */
  scopes: string[];
  /** Client requesting the authorization. */
  clientId: string;
}

/** A failure the OP shows on its own error page (never redirected to the client). */
export interface ConsentError {
  kind: 'error';
  error: string;
  errorDescription?: string;
  statusCode: number;
}

/** What POST /consent decided; pages/consent.ts turns it into HTTP. */
export type ConsentOutcome =
  | ConsentError
  /**
   * OIDC Core 1.0 Section 3.1.2.4: no decision was obtained — action was
   * missing, empty or unknown. Not access_denied (Section 3.1.2.6), so the
   * browser stays on the OP (400).
   */
  | { kind: 'invalid_decision' }
  /** No authenticated subject for this transaction: the login step was skipped or expired (400). */
  | { kind: 'session_missing' }
  /** Approved or denied: the authorization response for the client, ready in the URL. */
  | { kind: 'authorization_response'; location: string; cookies: string[] };

/** The fields of the consent form. */
export interface ConsentSubmission {
  csrfToken: string;
  /** 'approve' or 'deny' — the submit button values of the consent view. */
  action: string;
}

/** What the approved request was issued: the response parameters, the code and the granted scope. */
export interface ConsentedAuthorization {
  responseParams: AuthorizationResponseParams;
  authCodeData: AuthorizationCodeData;
  grantedScope: string[];
}

/**
 * The OP's own error page for a transaction that cannot continue: unknown,
 * finished or expired (400), or a csrf_token that does not belong to it (403).
 * It is never redirected to the client's redirect_uri: until the transaction
 * and its csrf_token check out, the OP cannot tell whose request this is, and
 * answering the client could hand a code for this End-User to someone else.
 */
function transactionErrorOutcome(error: unknown): ConsentError {
  if (!(error instanceof AuthTransactionError)) throw error;
  return { kind: 'error', error: error.message, statusCode: error.httpStatusCode };
}

/**
 * [load-transaction] The transaction this browser is in the middle of: the id
 * from the transaction cookie /authorize set (buildTransactionCookie() in
 * store.ts), loaded from the store. Returns the error to show instead when
 * there is none. OIDC Core 1.0 §3.1.2.4
 */
export async function loadTransaction(
  c: any,
): Promise<{ transactionId: string; transaction: AuthTransaction } | ConsentError> {
  const transactionId = parseTransactionId(c.req.header('Cookie') ?? null);
  if (!transactionId) {
    return {
      kind: 'error',
      error: 'No authorization request is in progress in this browser. Start again from the application.',
      statusCode: 400,
    };
  }
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  try {
    return { transactionId, transaction: await getAuthTransaction(transactionId, transactionStore) };
  } catch (error) {
    return transactionErrorOutcome(error);
  }
}

/**
 * [describe-consent-screen] Describe the form for a transaction: the
 * csrf_token, the client and the scopes this End-User is asked to grant.
 */
export async function describeConsentScreen(
${screenContextParam}  transaction: AuthTransaction,
): Promise<ConsentScreen> {
${consentGetScopeResolution}  return {
    kind: 'screen',
    csrfToken: transaction.csrfToken,
    scopes: ${consentDisplayScopes},
    clientId: transaction.clientId,
  };
}

/**
 * [reject-cross-origin-post] Refuse a consent form POST that the browser says
 * came from anywhere but the OP's own pages (403, never redirected). See
 * isSameOriginFormPost() in store.ts.
 */
export function rejectCrossOriginFormPost(c: any): ConsentError | undefined {
  const sameOrigin = isSameOriginFormPost(
    { origin: c.req.header('Origin') ?? null, secFetchSite: c.req.header('Sec-Fetch-Site') ?? null },
    c.get('config').issuer,
  );
  return sameOrigin ? undefined : { kind: 'error', error: CROSS_ORIGIN_FORM_POST_MESSAGE, statusCode: 403 };
}

/**
 * [validate-csrf-token] The csrf_token says the decision came from the form
 * the OP rendered for exactly this transaction; any other token is refused
 * (403) on the OP's own error page.
 */
export function validateConsentCsrfToken(
  transaction: AuthTransaction,
  csrfToken: string,
): ConsentError | undefined {
  try {
    validateCsrfToken(transaction, csrfToken);
    return undefined;
  } catch (error) {
    return transactionErrorOutcome(error);
  }
}
${jarmConsentHelpers}
${buildConsentRedirect}

/**
 * [deny-authorization] The End-User denied the request: finish the transaction
 * and answer access_denied to the client. OIDC Core 1.0 §3.1.2.6
 */
export async function denyAuthorizationRequest(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
  issuer: string,
): Promise<ConsentOutcome> {
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  await transactionStore.delete('auth_txn:' + transactionId);
  await authSessionStore.delete(transactionId);${denyJarmNote}
  return buildConsentRedirect(${redirectContextArgs}transaction.redirectUri, {
    error: 'access_denied',
    state: transaction.state,
  }, issuer);
}

/**
 * [validate-decision] OIDC Core 1.0 Section 3.1.2.4: "the Authorization Server
 * MUST obtain an authorization decision before releasing information to the
 * Relying Party." The affirmative decision is therefore detected on an
 * allowlist: a missing, empty or unknown 'action' means no decision was
 * obtained, so it must not approve. Deciding by "not deny" would approve every
 * unexpected value instead.
 *
 * 'approve' is the decision value this provider accepts, and it MUST stay in
 * sync with the Approve button in views.ts consentPage(). Changing it here
 * without changing the button (or the other way round) makes every approval
 * fail with the 400 pages/consent.ts shows for this outcome.
 *
 * Section 3.1.2.6: access_denied means the End-User denied the request, which
 * is not the same as no decision at all — an unrecognized value stops here on
 * the OP's own error page instead of being redirected back to the client.
 */
export function validateConsentDecision(action: string): ConsentOutcome | undefined {
  return action === 'approve' ? undefined : { kind: 'invalid_decision' };
}

/**
 * [require-authenticated-subject] The subject the login step stored for this
 * transaction (the per-transaction hand-off). Without one the login step was
 * skipped or has expired, and no code may be issued.
 */
export async function requireAuthenticatedSubject(
  c: any,
  transactionId: string,
): Promise<AuthSessionInfo | undefined> {
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  return (await authSessionStore.get(transactionId)) ?? undefined;
}

/**
 * [issue-authorization-code] Finish the transaction and issue the
 * authorization code for the granted scope. OIDC Core 1.0 §3.1.2.5 / §3.1.3.1
 * (the code lives config.authorizationCodeTtl seconds, 300 by default).
 *
 * transaction.scope already went through applyOfflineAccessPolicy when the
 * authorization request was validated: whether offline_access may be granted
 * (OIDC Core 1.0 §11 prompt=consent, and refresh_token among the client's
 * registered grant_types) was settled there, so it is not filtered again.
 */
export async function issueConsentedAuthorizationCode(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
  session: AuthSessionInfo,
): Promise<ConsentedAuthorization> {
  const config = c.get('config');
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const authCodeStore = c.get('authCodeStore') ?? defaultAuthCodeStore;
  const responseParams = await completeAuthTransaction(transactionId, transaction, transactionStore);
${consentGrantedScope}
  const authCodeData = await createAuthorizationCode({
    authorizationResponse: { ...responseParams, scope: grantedScope },
    subject: session.subject,
    authTime: session.authTime,
    // Bind the online refresh token to this login session (the sessionId the
    // login step put on the auth session): logging out revokes that token too.
    sessionId: session.sessionId,
    ttlSeconds: config.authorizationCodeTtl,
  });
  await authCodeStore.set(authCodeData.code, authCodeData);
  return { responseParams, authCodeData, grantedScope };
}

/**
 * [record-consent] Record the consent and the grant so a later prompt=none (or
 * non-interactive SSO) request can confirm it without UI, then clear the
 * per-transaction hand-off. Routed through the consentResolver so a custom
 * store can override persistence. Only the hand-off is cleared; the browser
 * (OP) session persists so SSO keeps working. OIDC Core 1.0 §3.1.2.1 / §3.1.2.4
 */
export async function recordConsentDecision(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
  session: AuthSessionInfo,
  authCodeData: AuthorizationCodeData,
  grantedScope: string[],
): Promise<void> {
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  const consentResolver = c.get('consentResolver') ?? defaultConsentResolver;
  await consentResolver.recordConsent?.(session.subject, transaction.clientId, grantedScope);
  await consentResolver.recordGrant?.(
    session.subject,
    transaction.clientId,
    authCodeData.grantId,
  );
  await authSessionStore.delete(transactionId);
}

/**
 * GET /consent: load the transaction this browser's cookie names and describe
 * the form, or the error to show instead when there is none.
 */
export async function prepareConsent(c: any): Promise<ConsentScreen | ConsentError> {
  // [load-transaction]
  const loaded = await loadTransaction(c);
  if ('kind' in loaded) return loaded;
  const { ${consentPrepareBindings} } = loaded;
  // [describe-consent-screen]
  return describeConsentScreen(${screenContextArg}transaction);
}

/**
 * POST /consent: record the decision and build the authorization response. The
 * steps run in the fixed order the screen needs (the consent endpoint of
 * \`maronn-oidc graph --detail steps\`).
 */
export async function submitConsent(c: any, input: ConsentSubmission): Promise<ConsentOutcome> {
  const { csrfToken, action } = input;

  // Checked before any decision is acted on: this step mints the authorization
  // code, so neither an approval nor a denial may come from anywhere else.
  // [reject-cross-origin-post] First the browser's own statement of where the
  // form was submitted from (isSameOriginFormPost() in store.ts): independent
  // of the cookie and the csrf_token, so a forged POST is stopped even if both
  // were planted.
  const sameOriginError = rejectCrossOriginFormPost(c);
  if (sameOriginError) return sameOriginError;

  // [load-transaction] The cookie says which transaction this browser is in.
  const loaded = await loadTransaction(c);
  if ('kind' in loaded) return loaded;
  const { transactionId, transaction } = loaded;

  // [validate-csrf-token] The csrf_token says the decision came from the form
  // the OP rendered for exactly that one.
  const csrfError = validateConsentCsrfToken(transaction, csrfToken);
  if (csrfError) return csrfError;

  // RFC 9207 §2: include the issuer identifier on every authorization response
  // (success and error) so clients can pin the issuer that produced the response.
  const issuer: string = c.get('config').issuer;

  // [deny-authorization]
  if (action === 'deny') {
    return denyAuthorizationRequest(c, transactionId, transaction, issuer);
  }

  // [validate-decision]
  const decisionError = validateConsentDecision(action);
  if (decisionError) return decisionError;

  // [require-authenticated-subject]
  const session = await requireAuthenticatedSubject(c, transactionId);
  if (!session) {
    return { kind: 'session_missing' };
  }

  // [issue-authorization-code]
  const { responseParams, authCodeData, grantedScope } = await issueConsentedAuthorizationCode(
    c,
    transactionId,
    transaction,
    session,
  );

  // [record-consent]
  await recordConsentDecision(c, transactionId, transaction, session, authCodeData, grantedScope);

  // [build-authorization-response] Back to the client with the authorization code.
  return buildConsentRedirect(${redirectContextArgs}responseParams.redirectUri, {
    code: authCodeData.code,
    state: responseParams.state,
  }, issuer);
}
`;
}
