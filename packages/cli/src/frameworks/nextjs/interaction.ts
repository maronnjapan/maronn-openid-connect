/**
 * Next.js templates for the interactive steps of the authorization flow: the
 * login and consent pages (React Server Components + Server Actions), the
 * Google login callback, and the OP's error screens (the oidc-error page and
 * the not-found.tsx / error.tsx of the login and consent pages).
 */
import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';
import { EXPERIMENTAL_PACKAGE, GOOGLE_LOGIN_PACKAGE } from '../hono/templates.js';

/** `login/session.ts` — starting the OP session once the End-User is authenticated. */
export function nextJsLoginSessionTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const loginMethods = features.googleLogin
    ? `shared
 * by every login method (the password form's Server Action and the Google
 * callback in login/google/route.ts).`
    : `called by
 * the login Server Action (actions.ts). A login method of your own (WebAuthn,
 * an upstream IdP) calls it the same way once it has authenticated the user.`;
  return `/**
 * Starting the OP browser session once the End-User is authenticated — ${loginMethods}
 */
import { cookies } from 'next/headers';
import { generateRandomString, type AuthTransaction } from '${corePkg}';
import { stores } from '../_oidc-provider/provider';
import { SESSION_COOKIE_NAME } from '../_oidc-provider/store';

/**
 * Start the OP session for subject and hand it to the consent step of this
 * transaction.
 *
 * The session (OIDC Core 1.0 §3.1.2.3) is what SSO, prompt=none and max_age
 * read back on later authorization requests: an opaque id in an HttpOnly
 * cookie, with the same attributes as buildSessionCookie() in store.ts —
 * Secure, and SameSite=Lax because Strict would drop it on the cross-site
 * redirect back from the client.
 */
export async function startSession(
  transactionId: string,
  transaction: AuthTransaction,
  subject: string,
): Promise<void> {
  const cookieStore = await cookies();

  // prompt=login / select_account require fresh authentication: discard any
  // existing hand-off for this transaction AND the browser's current session
  // (OIDC Core 1.0 §3.1.2.1 — prompt is a space-delimited list).
  const promptValues = transaction.prompt?.trim().split(/\\s+/).filter(Boolean) ?? [];
  if (promptValues.includes('login') || promptValues.includes('select_account')) {
    await stores.authSessionStore.delete(transactionId);
    const existingSessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    if (existingSessionId) await stores.browserSessionStore.delete(existingSessionId);
  }

  const authTime = Math.floor(Date.now() / 1000);
  const sessionId = generateRandomString(32);
  await stores.browserSessionStore.set(sessionId, { subject, authTime });

  // The per-transaction hand-off to the consent step. sessionId も渡すのは online
  // refresh token のため。consent 経由で発行する認可コードにこのセッションを引き継ぎ、
  // ログアウトで使えなくなる RT を作る。
  await stores.authSessionStore.set(transactionId, { subject, authTime, sessionId });

  cookieStore.set(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  });
}
`;
}

/** `_oidc-provider/transaction.ts` — the transaction the login and consent steps continue. */
export function nextJsTransactionTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const binding = features.transactionBinding;
  const navigationImport = binding
    ? `import { notFound, redirect } from 'next/navigation';
import { cookies } from 'next/headers';`
    : `import { notFound } from 'next/navigation';`;
  const coreImports = [
    'AuthTransactionError',
    'getAuthTransaction',
    ...(binding ? ['validateTransactionBinding'] : []),
    'type AuthTransaction',
  ];
  const bindingImports = binding
    ? `
import { errorPagePath } from './http';
import { TRANSACTION_BINDING_COOKIE_PREFIX } from './store';`
    : '';
  const bindingDoc = binding
    ? `
 *
 * OIDC Core 1.0 §3.1.2.3 / §3.1.2.4: transaction_id rides in the URL and can
 * leak, so it proves nothing about the browser presenting it. Only the browser
 * holding the transaction's binding cookie may continue it (see
 * buildTransactionBindingCookie() in store.ts); any other is sent to the OP's
 * error page before it sees a form or reaches a decision.`
    : '';
  // Without binding the lookup is all there is; with it, the transaction is
  // looked up first and then checked against this browser's binding cookie.
  const body = binding
    ? `  let transaction: AuthTransaction;
  try {
    transaction = await getAuthTransaction(transactionId, stores.transactionStore);
  } catch (error) {
    if (error instanceof AuthTransactionError) notFound();
    throw error;
  }

  try {
    await validateTransactionBinding(
      transaction,
      (await cookies()).get(TRANSACTION_BINDING_COOKIE_PREFIX + transactionId)?.value,
    );
  } catch (error) {
    if (error instanceof AuthTransactionError) redirect(errorPagePath(error.code, error.message));
    throw error;
  }
  return transaction;`
    : `  try {
    return await getAuthTransaction(transactionId, stores.transactionStore);
  } catch (error) {
    if (error instanceof AuthTransactionError) notFound();
    throw error;
  }`;
  return `/**
 * Looking up the authorization transaction the login and consent steps continue.
 */
${navigationImport}
import {
${coreImports.map((name) => `  ${name},`).join('\n')}
} from '${corePkg}';
import { stores } from './provider';${bindingImports}

/**
 * The authorization transaction transaction_id names, for the login and consent
 * pages and their Server Actions. When there is none — unknown, already
 * finished, or expired — the request ends in notFound(), which renders the
 * not-found.tsx beside the page: the End-User has to start over from the client
 * application.${bindingDoc}
 */
export async function requireTransaction(transactionId: string): Promise<AuthTransaction> {
${body}
}
`;
}

/** `_oidc-provider/error-view.tsx` — the layout every OP error screen shares. */
export function nextJsErrorViewTemplate(): string {
  return `/**
 * The layout of the OP's error screens: the error page (oidc-error/page.tsx)
 * and the not-found.tsx / error.tsx of the login and consent pages all render
 * it, so every way the browser stops on the OP looks the same. Restyle it here.
 */
import type { ReactNode } from 'react';

interface ErrorViewProps {
  /** The error code: an OAuth error, or one of the OP's own. */
  error: string;
  /** Text for the End-User. React escapes it, so it cannot inject markup. */
  description?: string;
  /** Anything the screen adds below the message, such as a retry button. */
  children?: ReactNode;
}

export function ErrorView({ error, description, children }: ErrorViewProps) {
  return (
    <main>
      <h1>Error</h1>
      <p>{error}</p>
      {description ? <p>{description}</p> : null}
      {children}
    </main>
  );
}
`;
}

const PAGE_LABELS = {
  login: { component: 'Login', action: 'loginAction' },
  consent: { component: 'Consent', action: 'consentAction' },
} as const;

/** `<segment>/not-found.tsx` — what notFound() renders for the login or consent page. */
export function nextJsNotFoundTemplate(page: 'login' | 'consent'): string {
  const { component, action } = PAGE_LABELS[page];
  return `import { ErrorView } from '../_oidc-provider/error-view';

/**
 * Not-found screen of the ${page} page (Next.js not-found.js): rendered when the
 * page or ${action} calls notFound() because transaction_id names no
 * authorization request — unknown, already finished, or expired. Next.js
 * answers it with HTTP 404. The End-User can only start over from the client
 * application.
 */
export default function ${component}NotFound() {
  return (
    <ErrorView
      error="transaction_not_found"
      description="This sign-in request was not found or has expired. Start again from the application."
    />
  );
}
`;
}

/** `<segment>/error.tsx` — the error boundary of the login or consent page. */
export function nextJsErrorBoundaryTemplate(page: 'login' | 'consent'): string {
  const { component, action } = PAGE_LABELS[page];
  return `'use client'; // Error boundaries must be Client Components.

import { ErrorView } from '../_oidc-provider/error-view';

/**
 * Error boundary of the ${page} page (Next.js error.js): the screen for an
 * exception nobody expected while rendering the page or running ${action} —
 * a store outage, a bug. Expected outcomes never land here: they redirect to the
 * OP's error page or call notFound().
 *
 * In production Next.js withholds the error message from the browser and passes
 * error.digest instead, which matches the entry in the server log. retry()
 * fetches and renders the page again.
 */
export default function ${component}Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <ErrorView error="server_error" description={error.digest ? 'Reference: ' + error.digest : undefined}>
      <button type="button" onClick={() => retry()}>
        Try again
      </button>
    </ErrorView>
  );
}
`;
}

/** `login/page.tsx` — the login form (React Server Component). */
export function nextJsLoginPageTemplate(features: OidcFeatureConfig = DEFAULT_FEATURES): string {
  const binding = features.transactionBinding;
  const google = features.googleLogin;
  const googleImports = google
    ? `
import Script from 'next/script';
import { issueGoogleLoginNonce } from '${GOOGLE_LOGIN_PACKAGE}';
import {
  buildGoogleSignInAttributes,
  GOOGLE_GSI_CLIENT_SCRIPT_URL,
} from '${GOOGLE_LOGIN_PACKAGE}/sign-in';
import { config, stores } from '../_oidc-provider/provider';`
    : '';
  const bindingDoc = binding
    ? ` A browser that did not
 * start the transaction never sees the form: it is sent to the OP's error page.`
    : '';
  const googleSignIn = google
    ? `
  // EXTENSION (google-login): the GIS configuration (g_id_onload attributes),
  // built only when config.googleLogin is set. Each render issues a fresh nonce
  // bound to this transaction; Google echoes it in the ID token, which is how
  // login/google/route.ts finds its way back to this authorization request.
  const googleLogin = config.googleLogin;
  const googleSignIn = googleLogin
    ? buildGoogleSignInAttributes({
        clientId: googleLogin.clientId,
        // Must equal an authorized redirect URI of the Google OAuth client. Built
        // on config.issuer, like every URL the OP builds for itself.
        loginUri: new URL('/login/google', config.issuer).toString(),
        nonce: await issueGoogleLoginNonce({
          transactionId,
          expiresAt: transaction.expiresAt,
          store: stores.googleLoginNonceStore,
        }),
        // OIDC Core 1.0 §3.1.2.1: pass login_hint on so Google can preselect the account.
        loginHint: transaction.loginHint,
        hostedDomain:
          typeof googleLogin.hostedDomain === 'string' ? googleLogin.hostedDomain : undefined,
      })
    : undefined;
`
    : '';
  const googleSignInJsx = google
    ? `
      {/*
        EXTENSION (google-login): the three elements GIS needs for redirect mode.
        googleSignIn holds the g_id_onload attributes (data-ux_mode="redirect",
        data-login_uri, data-nonce, ...) and spreads straight onto the element;
        GIS replaces .g_id_signin with the button — style it through the GIS
        button attributes (data-theme, data-size, data-text, ...).
      */}
      {googleSignIn ? (
        <section aria-label="Sign in with Google">
          <Script src={GOOGLE_GSI_CLIENT_SCRIPT_URL} strategy="afterInteractive" />
          <div {...googleSignIn} />
          <div className="g_id_signin" data-type="standard" />
        </section>
      ) : null}`
    : '';
  return `import { notFound } from 'next/navigation';${googleImports}
import { requireTransaction } from '../_oidc-provider/transaction';
import { loginAction } from './actions';

// /authorize redirects here with a per-request transaction_id, so the page must
// always render dynamically (never from a static cache).
export const dynamic = 'force-dynamic';

interface LoginPageProps {
  searchParams: Promise<{
    transaction_id?: string;
    error?: string;
    remaining?: string;
  }>;
}

/**
 * Login page (React Server Component).
 *
 * A real Next.js page, so the UI can be built with JSX, components, CSS modules
 * and the rest of the React ecosystem. The form posts to the loginAction Server
 * Action (actions.ts), which checks the credentials and starts the OP session.
 * Keep the hidden transaction_id / csrf_token fields when customizing it.
 *
 * A transaction_id that names no transaction renders not-found.tsx (see
 * requireTransaction() in _oidc-provider/transaction.ts).${bindingDoc}
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { transaction_id: transactionId, error, remaining } = await searchParams;
  if (!transactionId) notFound();
  const transaction = await requireTransaction(transactionId);
${googleSignIn}
  const errorMessage =
    error === 'invalid_credentials'
      ? \`Invalid credentials\${remaining ? \`. Attempts remaining: \${remaining}\` : ''}\`
      : null;

  return (
    <main>
      <h1>Login</h1>
      {errorMessage ? (
        <p role="alert" style={{ color: 'red' }}>
          {errorMessage}
        </p>
      ) : null}
      <form action={loginAction}>
        <input type="hidden" name="transaction_id" value={transactionId} />
        <input type="hidden" name="csrf_token" value={transaction.csrfToken} />
        <div>
          <label htmlFor="username">Username:</label>
          {/* OIDC Core 1.0 §3.1.2.1: login_hint MAY pre-fill the username. It is
              an untrusted hint, used for the initial value only. */}
          <input
            type="text"
            id="username"
            name="username"
            defaultValue={transaction.loginHint}
            required
          />
        </div>
        <div>
          <label htmlFor="password">Password:</label>
          <input type="password" id="password" name="password" required />
        </div>
        <button type="submit">Login</button>
      </form>${googleSignInJsx}
    </main>
  );
}
`;
}

/** `login/actions.ts` — the login form's Server Action. */
export function nextJsLoginActionTemplate(corePkg: string): string {
  return `'use server';

import { redirect } from 'next/navigation';
import {
  AuthTransactionError,
  AuthTransactionErrorCode,
  handleLoginFailure,
  validateCsrfToken,
} from '${corePkg}';
import { errorPagePath } from '../_oidc-provider/http';
import { stores } from '../_oidc-provider/provider';
import { requireTransaction } from '../_oidc-provider/transaction';
import { startSession } from './session';

/**
 * Login Server Action.
 *
 * Checks the credentials, starts the OP session and continues to the consent
 * step. A wrong password goes back to the form with the error in the query, so
 * the page renders the message. A submission the OP refuses ends on the OP's
 * error page (oidc-error/page.tsx), never at the client.
 */
export async function loginAction(formData: FormData): Promise<void> {
  const transactionId = String(formData.get('transaction_id') ?? '');
  const transaction = await requireTransaction(transactionId);

  // The CSRF token proves the submission came from the form this browser was shown.
  try {
    validateCsrfToken(transaction, String(formData.get('csrf_token') ?? ''));
  } catch (error) {
    if (error instanceof AuthTransactionError) redirect(errorPagePath(error.code, error.message));
    throw error;
  }

  // Swap point: replace this with your own credential check (LDAP, WebAuthn, an
  // upstream IdP) without touching anything above or below it.
  const user = await stores.userStore.authenticate(
    String(formData.get('username') ?? ''),
    String(formData.get('password') ?? ''),
  );
  if (!user) {
    const failure = await handleLoginFailure(transactionId, transaction, stores.transactionStore);
    if (!failure.canRetry) {
      // handleLoginFailure() deleted the transaction: this sign-in cannot continue.
      redirect(
        errorPagePath(
          AuthTransactionErrorCode.MaxAttemptsExceeded,
          'Too many login attempts. Start again from the application.',
        ),
      );
    }
    const remaining = failure.maxAttempts - failure.failedAttempts;
    redirect(
      \`/login?transaction_id=\${encodeURIComponent(transactionId)}&error=invalid_credentials&remaining=\${remaining}\`,
    );
  }

  await startSession(transactionId, transaction, user.sub);
  redirect(\`/consent?transaction_id=\${encodeURIComponent(transactionId)}\`);
}
`;
}

/** `login/google/route.ts` — EXTENSION (google-login): the login_uri Google posts to. */
export function nextJsGoogleLoginRouteTemplate(corePkg: string): string {
  return `/**
 * EXTENSION (google-login) — the Google login callback (login_uri).
 *
 * Sign in with Google (redirect mode) posts the ID token here once the user
 * picks an account. A Route Handler rather than a Server Action: the POST comes
 * from Google's page and carries no Server Action id. After the callback checks
 * it continues exactly like a password login: same session, same consent step.
 *
 * Transaction binding is deliberately NOT checked here: Google's POST is a
 * cross-site navigation, so the browser withholds SameSite=Lax cookies. The
 * single-use nonce stands in for it — it was issued to the login page, which
 * only the bound browser could load.
 *
 * A failed callback ends on the OP's error page (oidc-error/page.tsx), like
 * every error that must not reach a client.
 */
import { notFound } from 'next/navigation';
import { NextResponse } from 'next/server';
import { AuthTransactionError, getAuthTransaction } from '${corePkg}';
import {
  getDefaultGoogleIdTokenVerifier,
  GoogleLoginError,
  handleGoogleLoginRedirect,
  resolveGoogleLoginSubject,
  type GoogleAccountResolver,
  type GoogleIdTokenPayload,
  type GoogleIdTokenVerifier,
} from '${GOOGLE_LOGIN_PACKAGE}';
import { readFormFields, redirectToErrorPage } from '../../_oidc-provider/http';
import { config, stores } from '../../_oidc-provider/provider';
import { startSession } from '../session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Verifies the ID token Google posts: google-auth-library
 * (OAuth2Client.verifyIdToken) with a process-wide certificate cache. Replace
 * it for tests or a proxied environment.
 */
const googleIdTokenVerifier: GoogleIdTokenVerifier = getDefaultGoogleIdTokenVerifier();

/**
 * Maps a verified Google account to the OP subject: just-in-time provisioning
 * through the user store (userStore.linkGoogleAccount), keyed by the Google sub.
 */
const googleAccountResolver: GoogleAccountResolver = {
  resolveSubject: async (account: GoogleIdTokenPayload) =>
    (await stores.userStore.linkGoogleAccount(account)).sub,
};

export async function POST(request: Request): Promise<Response> {
  const googleLogin = config.googleLogin;
  // Without config.googleLogin there is no Google login to call back into.
  if (!googleLogin) notFound();

  let transactionId: string;
  let subject: string;
  try {
    // Double Submit Cookie -> google-auth-library verification -> nonce lookup,
    // in the order Google's server-side verification guide prescribes.
    const login = await handleGoogleLoginRedirect({
      params: await readFormFields(request),
      cookieHeader: request.headers.get('Cookie'),
      clientId: googleLogin.clientId,
      verifier: googleIdTokenVerifier,
      nonceStore: stores.googleLoginNonceStore,
      hostedDomain: googleLogin.hostedDomain,
      requireVerifiedEmail: googleLogin.requireVerifiedEmail,
    });
    transactionId = login.transactionId;
    subject = await resolveGoogleLoginSubject(login.account, googleAccountResolver);
  } catch (error) {
    // Until the nonce is verified the OP cannot tell whose transaction this is,
    // so a failed callback can only end on the OP.
    if (!(error instanceof GoogleLoginError)) throw error;
    return redirectToErrorPage(error.code, error.message);
  }

  let transaction;
  try {
    transaction = await getAuthTransaction(transactionId, stores.transactionStore);
  } catch (error) {
    if (!(error instanceof AuthTransactionError)) throw error;
    return redirectToErrorPage(error.code, error.message);
  }

  await startSession(transactionId, transaction, subject);
  const consentUrl = new URL('/consent', config.issuer);
  consentUrl.searchParams.set('transaction_id', transactionId);
  return NextResponse.redirect(consentUrl, 302);
}
`;
}

/** `consent/page.tsx` — the consent form (React Server Component). */
export function nextJsConsentPageTemplate(
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
): string {
  const binding = features.transactionBinding;
  const customScopesDeclared = scopes.length > 0;
  const scopeImports = customScopesDeclared
    ? `
import { stores } from '../_oidc-provider/provider';
import { resolveGrantableScopes } from '../_oidc-provider/scopes';`
    : '';
  const bindingDoc = binding
    ? ` A browser that did not
 * start the transaction never sees the form: it is sent to the OP's error page.`
    : '';
  const displayedScopes = customScopesDeclared
    ? `
  // Show only what THIS End-User can actually grant (resolveGrantableScopes in
  // scopes.ts). The subject comes from the login step's hand-off; without one
  // the request is shown as-is, and the Server Action stops on the same missing
  // session.
  const requestedScopes = transaction.scope.split(' ').filter(Boolean);
  const consentSession = await stores.authSessionStore.get(transactionId);
  const scopes = consentSession
    ? await resolveGrantableScopes(requestedScopes, consentSession.subject)
    : requestedScopes;
`
    : `
  const scopes = transaction.scope.split(' ').filter(Boolean);
`;
  return `import { notFound } from 'next/navigation';${scopeImports}
import { requireTransaction } from '../_oidc-provider/transaction';
import { consentAction } from './actions';

export const dynamic = 'force-dynamic';

interface ConsentPageProps {
  searchParams: Promise<{ transaction_id?: string }>;
}

/**
 * Consent page (React Server Component).
 *
 * A real Next.js page, so the consent UI can be built with JSX and React
 * components. The form posts to the consentAction Server Action (actions.ts).
 *
 * A transaction_id that names no transaction renders not-found.tsx (see
 * requireTransaction() in _oidc-provider/transaction.ts).${bindingDoc}
 */
export default async function ConsentPage({ searchParams }: ConsentPageProps) {
  const { transaction_id: transactionId } = await searchParams;
  if (!transactionId) notFound();
  const transaction = await requireTransaction(transactionId);
${displayedScopes}
  return (
    <main>
      <h1>Authorize Application</h1>
      <p>
        Client <strong>{transaction.clientId}</strong> is requesting access to the
        following scopes:
      </p>
      <ul>
        {scopes.map((scope) => (
          <li key={scope}>{scope}</li>
        ))}
      </ul>
      {/*
        The submit buttons carry the authorization decision (OIDC Core 1.0
        §3.1.2.4). consentAction accepts exactly 'approve' and 'deny' and rejects
        everything else, so keep both values when customizing this markup:
        renaming 'approve' makes every approval fail with an error page.
      */}
      <form action={consentAction}>
        <input type="hidden" name="transaction_id" value={transactionId} />
        <input type="hidden" name="csrf_token" value={transaction.csrfToken} />
        <button type="submit" name="action" value="approve">
          Approve
        </button>
        <button type="submit" name="action" value="deny">
          Deny
        </button>
      </form>
    </main>
  );
}
`;
}

/** `consent/actions.ts` — the consent form's Server Action. */
export function nextJsConsentActionTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
): string {
  const binding = features.transactionBinding;
  const jarm = features.jarm;
  const customScopesDeclared = scopes.length > 0;
  const coreImports = [
    'AuthTransactionError',
    'completeAuthTransaction',
    'createAuthorizationCode',
    'validateCsrfToken',
    ...(jarm ? ['selectSigningKeyByAlg'] : []),
    'type AuthTransaction',
    ...(jarm ? ['type SigningKey'] : []),
  ];
  const nextImports = binding
    ? `import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';`
    : `import { redirect } from 'next/navigation';`;
  const jarmImports = jarm
    ? `
import {
  buildJarmRedirectUrl,
  createJarmResponseJwt,
  type JarmAuthTransactionFields,
} from '${EXPERIMENTAL_PACKAGE}/jarm';`
    : '';
  const providerImport = jarm
    ? `import { errorPagePath } from '../_oidc-provider/http';
import { config, loadSigningKeys, resolvers, stores } from '../_oidc-provider/provider';`
    : `import { errorPagePath } from '../_oidc-provider/http';
import { config, resolvers, stores } from '../_oidc-provider/provider';`;
  const bindingStoreImport = binding
    ? `
import { TRANSACTION_BINDING_COOKIE_PREFIX } from '../_oidc-provider/store';`
    : '';
  const jarmConfigImport = jarm
    ? `
import { jarmConfig } from '../_oidc-provider/jarm';`
    : '';
  const customScopeImport = customScopesDeclared
    ? `
import { resolveGrantableScopes } from '../_oidc-provider/scopes';`
    : '';
  const clearBinding = (indent: string) =>
    binding
      ? `${indent}// The transaction is over; drop its binding cookie.
${indent}(await cookies()).delete(TRANSACTION_BINDING_COOKIE_PREFIX + transactionId);
`
      : '';
  const grantedScope = customScopesDeclared
    ? `  // Apply the scope policy (resolveGrantableScopes in scopes.ts — the place for
  // per-user filtering). A dropped scope narrows the grant rather than failing
  // the request: RFC 6749 §3.3 lets the authorization server issue a narrower
  // scope, and the token response reports what was granted.
  const grantedScope = await resolveGrantableScopes(
    transaction.scope.split(' ').filter(Boolean),
    session.subject,
  );`
    : `  // transaction.scope は認可リクエスト検証時に applyOfflineAccessPolicy を通した後の値。
  // offline_access の可否（OIDC Core 1.0 §11 の prompt=consent と、クライアント登録
  // grant_types に refresh_token があるか）はそこで確定しているので再フィルタしない。
  const grantedScope = transaction.scope.split(' ').filter(Boolean);`;
  const responseUrlHelper = jarm
    ? `/**
 * EXPERIMENTAL — JARM §3: the key a response JWT is signed with, for a
 * transaction on which the authorize step recorded response_mode=query.jwt (the
 * transaction store MUST persist fields it does not know about); undefined for
 * the plain query response. The JWT declares alg RS256, so the key is picked by
 * alg from the registered set — the key /.well-known/jwks.json publishes.
 */
async function jarmSigningKeyFor(
  transaction: AuthTransaction & JarmAuthTransactionFields,
): Promise<SigningKey | undefined> {
  if (transaction.jarmResponseMode !== 'query.jwt') return undefined;
  return selectSigningKeyByAlg((await loadSigningKeys()).general, 'RS256');
}

/**
 * The authorization response URL: the parameters in the query with iss
 * (RFC 9207 §2) — or, EXPERIMENTAL JARM §2.3.1, with a JARM signing key, one
 * signed JWT in the \`response\` parameter. In JARM mode the JWT's iss claim
 * replaces the iss parameter.
 */
async function authorizationResponseUrl(
  transaction: AuthTransaction,
  parameters: Record<string, string | undefined>,
  jarmSigningKey: SigningKey | undefined,
): Promise<string> {
  if (jarmSigningKey) {
    return buildJarmRedirectUrl(
      transaction.redirectUri,
      await createJarmResponseJwt({
        issuer: config.issuer,
        clientId: transaction.clientId,
        parameters,
        signingKey: jarmSigningKey,
        lifetimeSeconds: jarmConfig.jarmResponseLifetimeSeconds,
      }),
    );
  }
  const url = new URL(transaction.redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  url.searchParams.set('iss', config.issuer);
  return url.toString();
}`
    : `/**
 * The authorization response URL: the parameters in the query, with iss on
 * every response, success and error alike (RFC 9207 §2).
 */
function authorizationResponseUrl(
  transaction: AuthTransaction,
  parameters: Record<string, string | undefined>,
): string {
  const url = new URL(transaction.redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  url.searchParams.set('iss', config.issuer);
  return url.toString();
}`;
  const responseAwait = jarm ? 'await ' : '';
  const jarmKeyArgument = jarm ? ', jarmSigningKey' : '';
  const jarmKeyStep = jarm
    ? `
  // EXPERIMENTAL — JARM: load the response signing key before anything is
  // recorded, so a key outage stops here instead of after the code and the
  // consent were stored.
  let jarmSigningKey: SigningKey | undefined;
  try {
    jarmSigningKey = await jarmSigningKeyFor(transaction);
  } catch {
    redirect(errorPagePath('server_error', 'Failed to load the response signing key'));
  }
`
    : '';
  return `'use server';

${nextImports}
import {
${coreImports.map((name) => `  ${name},`).join('\n')}
} from '${corePkg}';${jarmImports}
${providerImport}${bindingStoreImport}${jarmConfigImport}${customScopeImport}
import { requireTransaction } from '../_oidc-provider/transaction';

/**
 * Consent Server Action: records the End-User's decision and sends the browser
 * back to the client with the authorization response (OIDC Core 1.0 §3.1.2.5 /
 * §3.1.2.6).
 */
export async function consentAction(formData: FormData): Promise<void> {
  const transactionId = String(formData.get('transaction_id') ?? '');
  const action = String(formData.get('action') ?? '');
  const transaction${jarm ? ': AuthTransaction & JarmAuthTransactionFields' : ''} = await requireTransaction(transactionId);

  // The CSRF token proves the decision came from the form this browser was
  // shown. Checked before any decision is acted on: this step mints the
  // authorization code.
  try {
    validateCsrfToken(transaction, String(formData.get('csrf_token') ?? ''));
  } catch (error) {
    if (error instanceof AuthTransactionError) redirect(errorPagePath(error.code, error.message));
    throw error;
  }
${jarmKeyStep}
  if (action === 'deny') {
    await stores.transactionStore.delete('auth_txn:' + transactionId);
    await stores.authSessionStore.delete(transactionId);
${clearBinding('    ')}    redirect(${responseAwait}authorizationResponseUrl(transaction, {
      error: 'access_denied',
      state: transaction.state,
    }${jarmKeyArgument}));
  }

  // OIDC Core 1.0 §3.1.2.4: "the Authorization Server MUST obtain an
  // authorization decision before releasing information to the Relying Party."
  // This action mints the authorization code, so the affirmative decision is
  // detected on an allowlist: a missing, empty or unknown 'action' means no
  // decision was obtained and must not approve. 'approve' MUST stay in sync with
  // the Approve button in page.tsx.
  //
  // §3.1.2.6: access_denied means the End-User denied the request, which is not
  // the same as no decision at all — an unrecognized value therefore goes to the
  // OP's own error page instead of back to the client.
  if (action !== 'approve') {
    redirect(
      errorPagePath('invalid_request', 'Invalid consent decision. Please use the Approve or Deny button.'),
    );
  }

  // The login step's hand-off: no authenticated subject means the login step
  // was skipped or has expired.
  const session = await stores.authSessionStore.get(transactionId);
  if (!session) {
    redirect(\`/login?transaction_id=\${encodeURIComponent(transactionId)}\`);
  }

  const responseParams = await completeAuthTransaction(
    transactionId,
    transaction,
    stores.transactionStore,
  );

${grantedScope}

  // OIDC Core 1.0 §3.1.3.1: TTL is configurable via ProviderConfig (300 seconds by default).
  const authCodeData = await createAuthorizationCode({
    authorizationResponse: { ...responseParams, scope: grantedScope },
    subject: session.subject,
    authTime: session.authTime,
    // online refresh token をこのログインセッションへ束縛する（login step が
    // authSessionStore へ載せた値）。ログアウトすれば RT も使えなくなる。
    sessionId: session.sessionId,
    ttlSeconds: config.authorizationCodeTtl,
  });
  await stores.authCodeStore.set(authCodeData.code, authCodeData);

  // Record the consent so a later prompt=none (or SSO) request can confirm it
  // without UI (OIDC Core 1.0 §3.1.2.1 / §3.1.2.4), and the grant, so
  // withdrawing that consent revokes the tokens issued from it. Only the
  // per-transaction hand-off is cleared; the OP session persists for SSO.
  await resolvers.consentResolver.recordConsent?.(session.subject, transaction.clientId, grantedScope);
  await resolvers.consentResolver.recordGrant(session.subject, transaction.clientId, authCodeData.grantId);
  await stores.authSessionStore.delete(transactionId);

${clearBinding('  ')}  redirect(${responseAwait}authorizationResponseUrl(transaction, {
    code: authCodeData.code,
    state: responseParams.state,
  }${jarmKeyArgument}));
}

${responseUrlHelper}
`;
}

/** `oidc-error/page.tsx` — the OP's own error page. */
export function nextJsErrorPageTemplate(): string {
  return `import type { Metadata } from 'next';
import { ErrorView } from '../_oidc-provider/error-view';

// The Authorization Endpoint, the login / consent steps and the Google callback
// send the browser here with error / error_description in the query, so the
// page renders per request.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Error',
  // An error screen is never a search result.
  robots: { index: false },
};

interface OidcErrorPageProps {
  searchParams: Promise<{ error?: string; error_description?: string }>;
}

/**
 * The OP's own error page (OIDC Core 1.0 §3.1.2.2).
 *
 * Errors that must not be redirected to the client end up here: an unknown
 * client_id, an unregistered redirect_uri, a transaction this browser may not
 * continue, a consent POST without a decision, a failed Google callback. It is
 * drawn by ErrorView (_oidc-provider/error-view.tsx), like the not-found and
 * error screens of the login and consent pages.
 */
export default async function OidcErrorPage({ searchParams }: OidcErrorPageProps) {
  const { error, error_description: errorDescription } = await searchParams;

  return <ErrorView error={error ?? 'invalid_request'} description={errorDescription} />;
}
`;
}
