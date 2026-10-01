/**
 * Consent step (API layer: logic only).
 *
 * Everything the consent screen has to decide lives here as plain functions:
 * loading the transaction, the User-Agent binding, the scope policy, the
 * authorization decision, the authorization code, the consent record and the
 * authorization response URL (RFC 6749 §4.1.2 / RFC 9207 iss / JARM). None of
 * them builds a Response — each returns an outcome, and pages/consent.ts turns
 * that outcome into a screen or a redirect. The UI can therefore be changed
 * without touching this file.
 */
import {
  getAuthTransaction,
  validateCsrfToken,
  validateTransactionBinding,
  AuthTransactionError,
  type AuthTransaction,
  completeAuthTransaction,
  createAuthorizationCode,
  selectSigningKeyByAlg,
  type SigningKey,
} from '@maronn-openid-connect/core';
import {
  consentResolver as defaultConsentResolver,
} from '../resolvers.js';
import {
  transactionStore as defaultTransactionStore,
  authCodeStore as defaultAuthCodeStore,
  authSessionStore as defaultAuthSessionStore,
  buildClearedTransactionBindingCookie,
  parseTransactionBindingSecret,
} from '../store.js';
import {
  buildJarmRedirectUrl,
  createJarmResponseJwt,
  type JarmAuthTransactionFields,
} from '@maronn-openid-connect/experimental/jarm';
import { jarmConfig } from './jarm.js';

/** What the consent form needs, prepared for GET /consent. */
export interface ConsentScreen {
  kind: 'screen';
  transactionId: string;
  /** Must be posted back as the csrf_token field. */
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
  transactionId: string;
  csrfToken: string;
  /** 'approve' or 'deny' — the submit button values of the consent view. */
  action: string;
}

/**
 * Enforce that this step comes from the User-Agent that started the transaction
 * (OIDC Core 1.0 Section 3.1.2.3 / 3.1.2.4). Returns the error to show, or
 * undefined when the binding holds.
 *
 * The failure is shown by the OP itself and never redirected to the client's
 * redirect_uri: without a verified owner, answering the client would let an
 * attacker who lured a victim into their own transaction collect a code for the
 * victim's identity. See buildTransactionBindingCookie() in store.ts.
 */
async function rejectUnboundTransaction(
  c: any,
  transaction: AuthTransaction,
  transactionId: string,
): Promise<ConsentError | undefined> {
  try {
    await validateTransactionBinding(
      transaction,
      parseTransactionBindingSecret(c.req.header('Cookie') ?? null, transactionId),
    );
    return undefined;
  } catch (error) {
    if (!(error instanceof AuthTransactionError)) throw error;
    return { kind: 'error', error: error.message, statusCode: error.httpStatusCode };
  }
}

/**
 * EXPERIMENTAL — JARM (JWT Secured Authorization Response Mode).
 *
 * The authorize step recorded the requested response mode on the transaction
 * (jarmResponseMode). This step only ever sees the transaction it read back
 * from the store, so the auth transaction store MUST persist fields it does not
 * know about — otherwise a client that asked for a JWT response silently gets a
 * plain query response instead. conformance.test.ts pins that round trip.
 */
function resolveJarmResponse(
  c: any,
  transaction: AuthTransaction & JarmAuthTransactionFields,
): JarmResponseContext | undefined {
  if (transaction.jarmResponseMode !== 'query.jwt') return undefined;
  // JARM Section 3: the response JWT always declares alg RS256, so the key is
  // picked by alg from the registered key set rather than taken from the
  // general-purpose ACTIVE key, which the SigningKeyProvider contract does not
  // guarantee to be RS256. Its public half is published at
  // /.well-known/jwks.json under the same kid. The single-key context is kept as
  // a fallback for providers that never populated the key set; on the default
  // single RS256 key both branches resolve the same key.
  const jarmSigningKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
  return {
    issuer: c.get('config').issuer,
    clientId: transaction.clientId,
    signingKey: jarmSigningKeys.length > 0
      ? selectSigningKeyByAlg(jarmSigningKeys, 'RS256')
      : {
          privateKey: c.get('privateKey'),
          publicJwk: c.get('publicJwk'),
          keyId: c.get('keyId'),
        },
  };
}

type JarmResponseContext = {
  issuer: string;
  clientId: string;
  signingKey: SigningKey;
};

/**
 * EXPERIMENTAL — JARM Section 2.3.1: deliver the authorization response as the
 * single `response` query parameter holding a signed JWT. Without a JARM
 * transaction this is the plain query response the OP has always produced
 * (RFC 9207 Section 2 appends iss; in JARM mode the JWT's iss claim carries the
 * same statement, so no plain iss parameter is added).
 */
async function buildConsentRedirect(
  jarm: JarmResponseContext | undefined,
  redirectUri: string,
  parameters: Record<string, string | undefined>,
  issuer: string,
): Promise<string> {
  if (jarm) {
    return buildJarmRedirectUrl(
      redirectUri,
      await createJarmResponseJwt({
        issuer: jarm.issuer,
        clientId: jarm.clientId,
        parameters,
        signingKey: jarm.signingKey,
        lifetimeSeconds: jarmConfig.jarmResponseLifetimeSeconds,
      }),
    );
  }
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  url.searchParams.set('iss', issuer);
  return url.toString();
}

/**
 * GET /consent: load the transaction and describe the form, or the error to
 * show instead when this browser may not see it.
 */
export async function prepareConsent(
  c: any,
  transactionId: string,
): Promise<ConsentScreen | ConsentError> {
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const transaction = await getAuthTransaction(transactionId, transactionStore);

  // Checked BEFORE the form is described: the consent page embeds csrf_token,
  // so a third party holding a leaked transaction_id must not be able to read
  // it and then complete the consent step on the End-User's behalf.
  const bindingError = await rejectUnboundTransaction(c, transaction, transactionId);
  if (bindingError) return bindingError;

  return {
    kind: 'screen',
    transactionId,
    csrfToken: transaction.csrfToken,
    scopes: transaction.scope.split(' ').filter(Boolean),
    clientId: transaction.clientId,
  };
}

/**
 * POST /consent: record the decision and build the authorization response.
 */
export async function submitConsent(c: any, input: ConsentSubmission): Promise<ConsentOutcome> {
  const { transactionId, csrfToken, action } = input;

  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const authCodeStore = c.get('authCodeStore') ?? defaultAuthCodeStore;
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;

  const transaction = await getAuthTransaction(transactionId, transactionStore);
  // Checked before validateCsrfToken and before any decision is acted on: this
  // is the step that mints the authorization code, so an unbound caller must not
  // reach it — neither to approve nor to deny on the End-User's behalf.
  const bindingError = await rejectUnboundTransaction(c, transaction, transactionId);
  if (bindingError) return bindingError;
  validateCsrfToken(transaction, csrfToken);

  // RFC 9207 §2: include the issuer identifier on every authorization response
  // (success and error) so clients can pin the issuer that produced the response.
  const config = c.get('config');
  const issuer = config.issuer;

  if (action === 'deny') {
    await transactionStore.delete('auth_txn:' + transactionId);
    await authSessionStore.delete(transactionId);
    // EXPERIMENTAL (JARM §2.1): a request that asked for response_mode=query.jwt
    // gets its error as a signed JWT too, so the client can verify that the OP
    // it trusts is the one that denied the request.
    return {
      kind: 'authorization_response',
      location: await buildConsentRedirect(resolveJarmResponse(c, transaction), transaction.redirectUri, {
        error: 'access_denied',
        state: transaction.state,
      }, issuer),
      cookies: [buildClearedTransactionBindingCookie(transactionId)],
    };
  }

  // OIDC Core 1.0 Section 3.1.2.4: "the Authorization Server MUST obtain an
  // authorization decision before releasing information to the Relying Party."
  // The affirmative decision is therefore detected on an allowlist: a missing,
  // empty or unknown 'action' means no decision was obtained, so it must not
  // approve. Deciding by "not deny" would approve every unexpected value instead.
  //
  // 'approve' is the decision value this provider accepts, and it MUST stay in
  // sync with the Approve button in views.ts consentPage(). Changing it here
  // without changing the button (or the other way round) makes every approval
  // fail with the 400 pages/consent.ts shows for this outcome.
  //
  // Section 3.1.2.6: access_denied means the End-User denied the request, which
  // is not the same as no decision at all — an unrecognized value stops here on
  // the OP's own error page instead of being redirected back to the client.
  if (action !== 'approve') {
    return { kind: 'invalid_decision' };
  }

  const session = await authSessionStore.get(transactionId);
  if (!session) {
    return { kind: 'session_missing' };
  }

  const responseParams = await completeAuthTransaction(
    transactionId,
    transaction,
    transactionStore,
  );

  // transaction.scope は認可リクエスト検証時に applyOfflineAccessPolicy を通した後の値。
  // offline_access の可否（OIDC Core 1.0 §11 の prompt=consent と、クライアント登録
  // grant_types に refresh_token があるか）はそこで確定しているので再フィルタしない。
  const grantedScope = transaction.scope.split(' ').filter(Boolean);

  // Generate authorization code via core helper
  // OIDC Core 1.0 Section 3.1.3.1: TTL is configurable via ProviderConfig
  // (defaults to 300 seconds — 5 minutes).
  const authCodeData = await createAuthorizationCode({
    authorizationResponse: { ...responseParams, scope: grantedScope },
    subject: session.subject,
    authTime: session.authTime,
    // online refresh token をこのログインセッションへ束縛する（login step が
    // authSessionStore へ載せた値）。ログアウトすれば RT も使えなくなる。
    sessionId: session.sessionId,
    ttlSeconds: config.authorizationCodeTtl,
  });
  await authCodeStore.set(authCodeData.code, authCodeData);

  // Record consent so a later prompt=none (or non-interactive SSO) request can
  // confirm it without UI (OIDC Core 1.0 Section 3.1.2.1 / 3.1.2.4). Routed
  // through the consentResolver so a custom store can override persistence.
  // Only the per-transaction handoff is cleared below; the browser (OP) session
  // persists so SSO keeps working.
  const consentResolver = c.get('consentResolver') ?? defaultConsentResolver;
  await consentResolver.recordConsent?.(session.subject, transaction.clientId, grantedScope);
  await consentResolver.recordGrant?.(
    session.subject,
    transaction.clientId,
    authCodeData.grantId,
  );

  await authSessionStore.delete(transactionId);

  // Back to the client with the authorization code
  return {
    kind: 'authorization_response',
    location: await buildConsentRedirect(resolveJarmResponse(c, transaction), responseParams.redirectUri, {
      code: authCodeData.code,
      state: responseParams.state,
    }, issuer),
    cookies: [buildClearedTransactionBindingCookie(transactionId)],
  };
}
