/**
 * Next.js templates for the interactive steps of the authorization flow: the
 * login and consent pages (React Server Components + Server Actions), the
 * Google login callback, and the OP's error page.
 */
import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';
import { EXPERIMENTAL_PACKAGE, GOOGLE_LOGIN_PACKAGE } from '../hono/templates.js';

/** `login/session.ts` — starting the OP session once the End-User is authenticated. */
export function nextJsLoginSessionTemplate(corePkg: string): string {
  return `/**
 * Starting the OP browser session once the End-User is authenticated — shared
 * by every login method (the password form's Server Action, and the Google
 * callback when google-login is generated).
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

/** The page shown instead of a form when the transaction cannot continue here. */
function noticeComponent(name: string, heading: string): string {
  return `/** Shown instead of the form when this transaction cannot continue here. */
function ${name}({ message }: { message: string }) {
  return (
    <main>
      <h1>${heading}</h1>
      <p role="alert">{message}</p>
    </main>
  );
}`;
}

/** `login/page.tsx` — the login form (React Server Component). */
export function nextJsLoginPageTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const binding = features.transactionBinding;
  const google = features.googleLogin;
  const coreImport = binding
    ? `import { AuthTransactionError, getAuthTransaction, validateTransactionBinding } from '${corePkg}';`
    : `import { AuthTransactionError, getAuthTransaction } from '${corePkg}';`;
  const bindingImports = binding
    ? `
import { cookies } from 'next/headers';`
    : '';
  const googleImports = google
    ? `
import Script from 'next/script';
import { issueGoogleLoginNonce } from '${GOOGLE_LOGIN_PACKAGE}';
import {
  buildGoogleSignInAttributes,
  GOOGLE_GSI_CLIENT_SCRIPT_URL,
} from '${GOOGLE_LOGIN_PACKAGE}/sign-in';`
    : '';
  const providerImport = google
    ? `import { config, stores } from '../_oidc-provider/provider';`
    : `import { stores } from '../_oidc-provider/provider';`;
  const bindingStoreImport = binding
    ? `
import { TRANSACTION_BINDING_COOKIE_PREFIX } from '../_oidc-provider/store';`
    : '';
  // Checked BEFORE the form is rendered: the form embeds csrf_token, so anyone
  // who could load it with a leaked transaction_id would obtain the token the
  // Server Action validates.
  const bindingCheck = binding
    ? `
  // OIDC Core 1.0 §3.1.2.3 / §3.1.2.4: the form embeds csrf_token, so only the
  // User-Agent that started the transaction may see it — transaction_id alone
  // is no proof, it rides in the URL and can leak (see store.ts).
  try {
    const cookieStore = await cookies();
    await validateTransactionBinding(
      transaction,
      cookieStore.get(TRANSACTION_BINDING_COOKIE_PREFIX + transactionId)?.value,
    );
  } catch (error) {
    if (!(error instanceof AuthTransactionError)) throw error;
    return <LoginNotice message="This authorization transaction was not started by this browser." />;
  }
`
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
  return `${coreImport}${bindingImports}${googleImports}
${providerImport}${bindingStoreImport}
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
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { transaction_id: transactionId, error, remaining } = await searchParams;

  if (!transactionId) {
    return <LoginNotice message="Missing transaction_id" />;
  }

  // handleLoginFailure() locked further attempts on this transaction.
  if (error === 'too_many_attempts') {
    return <LoginNotice message="Too many login attempts" />;
  }

  let transaction;
  try {
    transaction = await getAuthTransaction(transactionId, stores.transactionStore);
  } catch (transactionError) {
    if (!(transactionError instanceof AuthTransactionError)) throw transactionError;
    // Unknown or expired: the End-User has to start over from the client.
    return <LoginNotice message={transactionError.message} />;
  }
${bindingCheck}${googleSignIn}
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

${noticeComponent('LoginNotice', 'Login')}
`;
}

/** `login/actions.ts` — the login form's Server Action. */
export function nextJsLoginActionTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const binding = features.transactionBinding;
  const bindingCoreImport = binding ? '\n  validateTransactionBinding,' : '';
  const bindingImports = binding
    ? `
import { cookies } from 'next/headers';
import { TRANSACTION_BINDING_COOKIE_PREFIX } from '../_oidc-provider/store';`
    : '';
  const bindingCheck = binding
    ? `    // OIDC Core 1.0 §3.1.2.3 / §3.1.2.4: checked before validateCsrfToken. The
    // CSRF token only proves the value came from the form, and that form is
    // reachable by anyone holding transaction_id; the binding proves it is the
    // same browser (see store.ts).
    await validateTransactionBinding(
      transaction,
      (await cookies()).get(TRANSACTION_BINDING_COOKIE_PREFIX + transactionId)?.value,
    );
`
    : '';
  return `'use server';

import { redirect } from 'next/navigation';
import {
  AuthTransactionError,
  getAuthTransaction,
  handleLoginFailure,
  validateCsrfToken,${bindingCoreImport}
} from '${corePkg}';${bindingImports}
import { stores } from '../_oidc-provider/provider';
import { startSession } from './session';

/**
 * Login Server Action.
 *
 * Checks the credentials, starts the OP session and continues to the consent
 * step. A failed attempt goes back to the login page with the error in the
 * query, so the page renders the message.
 */
export async function loginAction(formData: FormData): Promise<void> {
  const transactionId = String(formData.get('transaction_id') ?? '');
  const loginPage = \`/login?transaction_id=\${encodeURIComponent(transactionId)}\`;

  let transaction;
  try {
    transaction = await getAuthTransaction(transactionId, stores.transactionStore);
${bindingCheck}    validateCsrfToken(transaction, String(formData.get('csrf_token') ?? ''));
  } catch (error) {
    if (error instanceof AuthTransactionError) {
      // The OP's own error page: a transaction this browser may not continue is
      // never answered toward the client.
      redirect(\`/oidc-error?\${new URLSearchParams({ error: error.code, error_description: error.message })}\`);
    }
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
      redirect(\`\${loginPage}&error=too_many_attempts\`);
    }
    const remaining = failure.maxAttempts - failure.failedAttempts;
    redirect(\`\${loginPage}&error=invalid_credentials&remaining=\${remaining}\`);
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
 */
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
import { errorPage, readFormFields } from '../../_oidc-provider/html';
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
  if (!googleLogin) {
    return errorPage('not_found', 404, 'Google login is not configured');
  }

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
    // so a failed callback is shown here and never redirected to a client.
    if (!(error instanceof GoogleLoginError)) throw error;
    return errorPage(error.code, error.httpStatusCode, error.message);
  }

  let transaction;
  try {
    transaction = await getAuthTransaction(transactionId, stores.transactionStore);
  } catch (error) {
    if (!(error instanceof AuthTransactionError)) throw error;
    return errorPage(error.message, error.httpStatusCode);
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
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
): string {
  const binding = features.transactionBinding;
  const customScopesDeclared = scopes.length > 0;
  const coreImport = binding
    ? `import { AuthTransactionError, getAuthTransaction, validateTransactionBinding } from '${corePkg}';`
    : `import { AuthTransactionError, getAuthTransaction } from '${corePkg}';`;
  const bindingImports = binding
    ? `
import { cookies } from 'next/headers';`
    : '';
  const bindingStoreImport = binding
    ? `
import { TRANSACTION_BINDING_COOKIE_PREFIX } from '../_oidc-provider/store';`
    : '';
  const customScopeImport = customScopesDeclared
    ? `
import { resolveGrantableScopes } from '../_oidc-provider/scopes';`
    : '';
  const bindingCheck = binding
    ? `
  // OIDC Core 1.0 §3.1.2.3 / §3.1.2.4: the form embeds csrf_token and its
  // submission mints the authorization code, so only the User-Agent that started
  // the transaction may see it (see store.ts).
  try {
    const cookieStore = await cookies();
    await validateTransactionBinding(
      transaction,
      cookieStore.get(TRANSACTION_BINDING_COOKIE_PREFIX + transactionId)?.value,
    );
  } catch (error) {
    if (!(error instanceof AuthTransactionError)) throw error;
    return <ConsentNotice message="This authorization transaction was not started by this browser." />;
  }
`
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
  return `${coreImport}${bindingImports}
import { stores } from '../_oidc-provider/provider';${bindingStoreImport}${customScopeImport}
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
 */
export default async function ConsentPage({ searchParams }: ConsentPageProps) {
  const { transaction_id: transactionId } = await searchParams;

  if (!transactionId) {
    return <ConsentNotice message="Missing transaction_id" />;
  }

  let transaction;
  try {
    transaction = await getAuthTransaction(transactionId, stores.transactionStore);
  } catch (transactionError) {
    if (!(transactionError instanceof AuthTransactionError)) throw transactionError;
    return <ConsentNotice message={transactionError.message} />;
  }
${bindingCheck}${displayedScopes}
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

${noticeComponent('ConsentNotice', 'Authorize Application')}
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
    'getAuthTransaction',
    'validateCsrfToken',
    ...(binding ? ['validateTransactionBinding'] : []),
    ...(jarm ? ['selectSigningKeyByAlg'] : []),
    'type AuthTransaction',
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
    ? `import { config, loadSigningKeys, resolvers, stores } from '../_oidc-provider/provider';`
    : `import { config, resolvers, stores } from '../_oidc-provider/provider';`;
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
  const bindingSetup = binding
    ? `  const cookieStore = await cookies();
  const bindingCookieName = TRANSACTION_BINDING_COOKIE_PREFIX + transactionId;
`
    : '';
  const bindingCheck = binding
    ? `    // OIDC Core 1.0 §3.1.2.3 / §3.1.2.4: checked before validateCsrfToken and
    // before any decision is acted on — this step mints the authorization code,
    // so an unbound caller must reach it neither to approve nor to deny.
    await validateTransactionBinding(transaction, cookieStore.get(bindingCookieName)?.value);
`
    : '';
  const clearBinding = (indent: string) =>
    binding
      ? `${indent}// The transaction is over; drop its binding cookie.
${indent}cookieStore.delete(bindingCookieName);
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
 * The authorization response URL: the parameters in the query with iss
 * (RFC 9207 §2) — or, EXPERIMENTAL JARM §2.3.1, one signed JWT in the
 * \`response\` parameter when the authorize step recorded response_mode=query.jwt
 * on the transaction (the transaction store MUST persist fields it does not
 * know about). In JARM mode the JWT's iss claim replaces the iss parameter.
 */
async function authorizationResponseUrl(
  transaction: AuthTransaction & JarmAuthTransactionFields,
  parameters: Record<string, string | undefined>,
): Promise<string> {
  if (transaction.jarmResponseMode === 'query.jwt') {
    // JARM §3: the response JWT declares alg RS256, so the key is picked by alg
    // from the registered set — the key /.well-known/jwks.json publishes.
    const keys = await loadSigningKeys();
    return buildJarmRedirectUrl(
      transaction.redirectUri,
      await createJarmResponseJwt({
        issuer: config.issuer,
        clientId: transaction.clientId,
        parameters,
        signingKey: selectSigningKeyByAlg(keys.general.registered, 'RS256'),
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
  return `'use server';

${nextImports}
import {
${coreImports.map((name) => `  ${name},`).join('\n')}
} from '${corePkg}';${jarmImports}
${providerImport}${bindingStoreImport}${jarmConfigImport}${customScopeImport}

/**
 * Consent Server Action: records the End-User's decision and sends the browser
 * back to the client with the authorization response (OIDC Core 1.0 §3.1.2.5 /
 * §3.1.2.6).
 */
export async function consentAction(formData: FormData): Promise<void> {
  const transactionId = String(formData.get('transaction_id') ?? '');
  const action = String(formData.get('action') ?? '');
${bindingSetup}
  let transaction;
  try {
    transaction = await getAuthTransaction(transactionId, stores.transactionStore);
${bindingCheck}    validateCsrfToken(transaction, String(formData.get('csrf_token') ?? ''));
  } catch (error) {
    if (error instanceof AuthTransactionError) {
      // The OP's own error page: a transaction this browser may not continue is
      // never answered toward the client.
      redirect(\`/oidc-error?\${new URLSearchParams({ error: error.code, error_description: error.message })}\`);
    }
    throw error;
  }

  if (action === 'deny') {
    await stores.transactionStore.delete('auth_txn:' + transactionId);
    await stores.authSessionStore.delete(transactionId);
${clearBinding('    ')}    redirect(${responseAwait}authorizationResponseUrl(transaction, {
      error: 'access_denied',
      state: transaction.state,
    }));
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
      '/oidc-error?error=invalid_request&error_description=' +
        encodeURIComponent('Invalid consent decision. Please use the Approve or Deny button.'),
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
  }));
}

${responseUrlHelper}
`;
}

/** `oidc-error/page.tsx` — the OP's own error page. */
export function nextJsErrorPageTemplate(): string {
  return `// The Authorization Endpoint and the login / consent steps send the browser here
// with error / error_description in the query, so the page renders per request.
export const dynamic = 'force-dynamic';

interface OidcErrorPageProps {
  searchParams: Promise<{ error?: string; error_description?: string }>;
}

/**
 * The OP's own error page (OIDC Core 1.0 §3.1.2.2).
 *
 * Errors that must not be redirected to the client end up here: an unknown
 * client_id, an unregistered redirect_uri, a transaction this browser may not
 * continue, a consent POST without a decision. React escapes the values, so a
 * crafted error_description cannot inject markup. Customize this page freely.
 */
export default async function OidcErrorPage({ searchParams }: OidcErrorPageProps) {
  const { error, error_description: errorDescription } = await searchParams;

  return (
    <main>
      <h1>Error</h1>
      <p>{error ?? 'invalid_request'}</p>
      {errorDescription ? <p>{errorDescription}</p> : null}
    </main>
  );
}
`;
}
