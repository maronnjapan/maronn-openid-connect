import { Hono } from 'hono';
import {
  getAuthTransaction,
  validateCsrfToken,
  validateTransactionBinding,
  AuthTransactionError,
  type AuthTransaction,
  completeAuthTransaction,
  createAuthorizationCode,
  type SigningKey,
} from '@maronn-openid-connect/core';
import {
  clientResolver as defaultClientResolver,
  consentResolver as defaultConsentResolver,
} from '../resolvers.js';
import {
  transactionStore as defaultTransactionStore,
  authCodeStore as defaultAuthCodeStore,
  authSessionStore as defaultAuthSessionStore,
  buildClearedTransactionBindingCookie,
  parseTransactionBindingSecret,
} from '../store.js';
import { defaultViews, renderView } from '../views.js';
import {
  buildJarmRedirectUrl,
  createJarmResponseJwt,
  type JarmAuthTransactionFields,
} from '@maronn-openid-connect/experimental/jarm';
import { jarmConfig } from './jarm.js';

export const consentApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * Enforce that this step comes from the User-Agent that started the transaction
 * (OIDC Core 1.0 Section 3.1.2.3 / 3.1.2.4). Returns an error Response to send
 * back, or undefined when the binding holds.
 *
 * The failure is rendered by the OP itself and never redirected to the client's
 * redirect_uri: without a verified owner, answering the client would let an
 * attacker who lured a victim into their own transaction collect a code for the
 * victim's identity. See buildTransactionBindingCookie() in store.ts.
 */
async function rejectUnboundTransaction(
  transaction: AuthTransaction,
  transactionId: string,
  cookieHeader: string | null,
  views: typeof defaultViews,
): Promise<Response | undefined> {
  try {
    await validateTransactionBinding(
      transaction,
      parseTransactionBindingSecret(cookieHeader, transactionId),
    );
    return undefined;
  } catch (error) {
    if (!(error instanceof AuthTransactionError)) throw error;
    return renderView(views.errorPage({
      error: error.message,
      statusCode: error.httpStatusCode,
    }), { status: error.httpStatusCode });
  }
}

/**
 * EXPERIMENTAL — JARM (JWT Secured Authorization Response Mode).
 *
 * The authorize route recorded the requested response mode on the transaction
 * (jarmResponseMode). This route only ever sees the transaction it read back
 * from the store, so the auth transaction store MUST persist fields it does not
 * know about — otherwise a client that asked for a JWT response silently gets a
 * plain query response instead. conformance.test.ts pins that round trip.
 */
function resolveJarmResponse(
  c: any,
  transaction: AuthTransaction & JarmAuthTransactionFields,
): JarmResponseContext | undefined {
  if (transaction.jarmResponseMode !== 'query.jwt') return undefined;
  // JARM Section 2.2: signed with the OP's general-purpose active signing key,
  // whose public half is published at /.well-known/jwks.json under the same kid.
  return {
    issuer: c.get('config').issuer,
    clientId: transaction.clientId,
    signingKey: {
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
 * Consent Page - GET
 * Displays the consent form for scope authorization.
 */
consentApp.get('/', async (c) => {
  const transactionId = c.req.query('transaction_id');
  if (!transactionId) {
    return c.text('Missing transaction_id', 400);
  }

  const views = c.get('views') ?? defaultViews;
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const transaction = await getAuthTransaction(transactionId, transactionStore);

  // Checked BEFORE rendering: the consent page embeds csrf_token, so a third
  // party holding a leaked transaction_id must not be able to read it here and
  // then complete POST /consent on the End-User's behalf.
  const bindingError = await rejectUnboundTransaction(
    transaction,
    transactionId,
    c.req.header('Cookie') ?? null,
    views,
  );
  if (bindingError) return bindingError;

  return renderView(views.consentPage({
    transactionId,
    csrfToken: transaction.csrfToken,
    scopes: transaction.scope.split(' ').filter(Boolean),
    clientId: transaction.clientId,
  }));
});

/**
 * Consent Handler - POST
 * Processes the consent decision.
 */
consentApp.post('/', async (c) => {
  const body = await c.req.parseBody();
  const transactionId = String(body['transaction_id'] ?? '');
  const csrfToken = String(body['csrf_token'] ?? '');
  const action = String(body['action'] ?? '');

  const views = c.get('views') ?? defaultViews;
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const authCodeStore = c.get('authCodeStore') ?? defaultAuthCodeStore;
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  const clientResolver = c.get('clientResolver') ?? defaultClientResolver;

  const transaction = await getAuthTransaction(transactionId, transactionStore);
  // Checked before validateCsrfToken and before any decision is acted on: this
  // is the step that mints the authorization code, so an unbound caller must not
  // reach it — neither to approve nor to deny on the End-User's behalf.
  const bindingError = await rejectUnboundTransaction(
    transaction,
    transactionId,
    c.req.header('Cookie') ?? null,
    views,
  );
  if (bindingError) return bindingError;
  validateCsrfToken(transaction, csrfToken);

  // RFC 9207 §2: include the issuer identifier on every authorization response
  // (success and error) so clients can pin the issuer that produced the response.
  const config = c.get('config');
  const issuer = config.issuer;

  if (action === 'deny') {
    await transactionStore.delete('auth_txn:' + transactionId);
    await authSessionStore.delete(transactionId);
    // The transaction is over; drop its binding cookie so the browser does not
    // keep one cookie per finished flow.
    c.header('Set-Cookie', buildClearedTransactionBindingCookie(transactionId));
    // EXPERIMENTAL (JARM §2.1): a request that asked for response_mode=query.jwt
    // gets its error as a signed JWT too, so the client can verify that the OP
    // it trusts is the one that denied the request.
    return c.redirect(
      await buildConsentRedirect(resolveJarmResponse(c, transaction), transaction.redirectUri, {
        error: 'access_denied',
        state: transaction.state,
      }, issuer),
    );
  }

  const session = await authSessionStore.get(transactionId);
  if (!session) {
    return renderView(views.errorPage({
      error: 'Authentication session not found. Please restart login.',
      statusCode: 400,
    }), { status: 400 });
  }

  const responseParams = await completeAuthTransaction(
    transactionId,
    transaction,
    transactionStore,
  );

  // Filter offline_access if the client does not allow it
  const clientConfig = await clientResolver.findClient(transaction.clientId);
  const grantedScope = transaction.scope.split(' ').filter((s) => {
    if (s === 'offline_access' && !clientConfig?.offlineAccessAllowed) return false;
    return Boolean(s);
  });

  // Generate authorization code via core helper
  // OIDC Core 1.0 Section 3.1.3.1: TTL is configurable via ProviderConfig
  // (defaults to 300 seconds — 5 minutes).
  const authCodeData = await createAuthorizationCode({
    authorizationResponse: { ...responseParams, scope: grantedScope },
    subject: session.subject,
    authTime: session.authTime,
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

  // The transaction is over; drop its binding cookie so the browser does not
  // keep one cookie per finished flow.
  c.header('Set-Cookie', buildClearedTransactionBindingCookie(transactionId));

  // Redirect back to client with authorization code
  return c.redirect(
    await buildConsentRedirect(resolveJarmResponse(c, transaction), responseParams.redirectUri, {
      code: authCodeData.code,
      state: responseParams.state,
    }, issuer),
  );
});
