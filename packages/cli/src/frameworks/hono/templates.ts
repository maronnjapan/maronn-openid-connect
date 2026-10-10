/**
 * Hono framework templates for OpenID Connect Provider
 */

import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';

/**
 * Package that hosts the experimental (unstable) features. Generated code only
 * imports from it when the matching experimental feature was enabled with
 * `--enable`, so the default output never references it.
 */
export const EXPERIMENTAL_PACKAGE = '@maronn-openid-connect/experimental';
export const GOOGLE_LOGIN_PACKAGE = '@maronn-openid-connect/google-login';

/**
 * Escape a value for embedding in a single-quoted string of the generated code.
 * Custom scope names and subjects come from the command line, so they are never
 * interpolated raw (RFC 6749 §3.3 allows an apostrophe inside a scope token).
 */
function singleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function oidcMethodGuardTemplate(features: OidcFeatureConfig): string {
  const introspectionMethod = features.introspection
    ? `  '/introspect': ['POST'],\n`
    : '';
  const revocationMethod = features.revocation
    ? `  '/revoke': ['POST'],\n`
    : '';
  // RFC 9126 §2.3: the PAR endpoint answers anything other than POST with 405.
  const parMethod = features.par ? `  '/par': ['POST'],\n` : '';
  // EXPERIMENTAL (RFC 8628): the device authorization endpoint is POST-only, and
  // the verification UI is a browser surface (GET form + POST submissions).
  const deviceMethods = features.deviceAuthorizationGrant
    ? `  '/device_authorization': ['POST'],
  '/device': ['GET', 'POST'],
  '/device/login': ['POST'],
  '/device/approve': ['POST'],\n`
    : '';
  // EXPERIMENTAL (CIBA Core 1.0): the backchannel authentication endpoint is
  // POST-only, and the authentication device UI is a browser surface (a GET
  // listing / login form + POST submissions).
  const cibaMethods = features.ciba
    ? `  '/backchannel_authentication': ['POST'],
  '/ciba': ['GET'],
  '/ciba/login': ['POST'],
  '/ciba/approve': ['POST'],\n`
    : '';
  // EXPERIMENTAL (RP-Initiated Logout 1.0 §2): the end_session_endpoint MUST
  // accept both GET and POST; the confirmation approve step is a browser form
  // POST (same naming family as /device/approve and /ciba/approve).
  const logoutMethods = features.rpInitiatedLogout
    ? `  '/logout': ['GET', 'POST'],
  '/logout/approve': ['POST'],\n`
    : '';
  // EXTENSION (google-login): the Google login callback (login_uri) receives a
  // browser form POST from Google's redirect; the login page keeps GET / POST.
  const googleLoginMethods = features.googleLogin
    ? `  '/login/google': ['POST'],\n`
    : '';
  return `const OIDC_ENDPOINT_METHODS: Readonly<Record<string, readonly string[]>> = {
  '/authorize': ['GET', 'POST'],
  '/token': ['POST'],
  '/userinfo': ['GET', 'POST'],
${introspectionMethod}${revocationMethod}${parMethod}${deviceMethods}${cibaMethods}${logoutMethods}  '/.well-known/jwks.json': ['GET'],
  '/.well-known/openid-configuration': ['GET'],
  '/login': ['GET', 'POST'],
${googleLoginMethods}  '/consent': ['GET', 'POST'],
};

async function enforceOidcEndpointMethod(c: any, next: () => Promise<void>): Promise<Response | void> {
  const pathname = new URL(c.req.url).pathname;
  const allowed = OIDC_ENDPOINT_METHODS[pathname];
  const method = c.req.method;
  // RFC 9110 §9.1: general-purpose servers MUST support HEAD wherever GET is
  // supported. HEAD shares GET semantics (§9.3.2), so let it through on any
  // GET-allowing endpoint; Hono runs the GET handler and strips the body.
  const isHeadOnGet = method === 'HEAD' && (allowed?.includes('GET') ?? false);
  if (allowed && !allowed.includes(method) && !isHeadOnGet) {
    c.header('Allow', allowed.join(', '));
    return c.body(null, 405);
  }
  await next();
}
`;
}

/**
 * --db: the app.ts / apply.ts pieces that make db/ the default storage. Without
 * --db every piece is the regular output, byte for byte.
 */
function honoStorageTemplateParts(db: boolean): {
  defaultStoresImport: string;
  dbImports: string;
  storageDoc: string;
  defaultStores: string;
} {
  return {
    defaultStoresImport: db ? '' : '  defaultProviderStores,\n',
    dbImports: db
      ? `import { createDatabase } from './db/instance.js';
import { createSqlProviderStores } from './db/stores.js';\n`
      : '',
    storageDoc: db
      ? 'Stores to use instead of db/: the SQL stores on the database db/instance.ts creates for each request.'
      : 'Persistent stores, or a request-aware factory for bindings such as Cloudflare D1.',
    defaultStores: db ? 'createSqlProviderStores(createDatabase(context))' : 'defaultProviderStores',
  };
}

export function appTemplate(
  _corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  db = false,
): string {
  const storageParts = honoStorageTemplateParts(db);
  const introspectionImport = features.introspection
    ? `import { introspectionApp } from './routes/introspection.js';\n`
    : '';
  const revocationImport = features.revocation
    ? `import { revocationApp } from './routes/revocation.js';\n`
    : '';
  const introspectionCors = features.introspection
    ? `  app.use('/introspect', protectedCors);\n`
    : '';
  const revocationCors = features.revocation
    ? `  app.use('/revoke', protectedCors);\n`
    : '';
  const introspectionMount = features.introspection
    ? `  app.route('/introspect', introspectionApp);\n`
    : '';
  const revocationMount = features.revocation
    ? `  app.route('/revoke', revocationApp);\n`
    : '';
  // EXPERIMENTAL (RFC 9126): the PAR endpoint is a back-channel, client-authenticated
  // POST endpoint, so it gets the same CORS policy as /token.
  const parImport = features.par
    ? `import { parApp } from './routes/par.js';\n`
    : '';
  const parCors = features.par
    ? `  app.use('/par', protectedCors);\n`
    : '';
  const parMount = features.par
    ? `  app.route('/par', parApp);\n`
    : '';
  const parStorageContext = features.par
    ? `    c.set('parStore', parStore);\n`
    : '';
  const parStoreImport = features.par
    ? `  parStore,\n`
    : '';
  // EXPERIMENTAL (RFC 8628): the device authorization endpoint is a back-channel,
  // client-authenticated POST endpoint, so it gets the same CORS policy as /token.
  // The verification UI (/device...) is reached by direct browser navigation, so
  // it needs no CORS headers — the same treatment as /login and /consent.
  const deviceImport = features.deviceAuthorizationGrant
    ? `import { deviceAuthorizationApp } from './routes/device-authorization.js';
import { devicePage } from './pages/device.js';\n`
    : '';
  const deviceCors = features.deviceAuthorizationGrant
    ? `  app.use('/device_authorization', protectedCors);\n`
    : '';
  const deviceMount = features.deviceAuthorizationGrant
    ? `  app.route('/device_authorization', deviceAuthorizationApp);
  app.route('/device', devicePage);\n`
    : '';
  const deviceStorageContext = features.deviceAuthorizationGrant
    ? `    c.set('deviceAuthorizationStore', deviceAuthorizationStore);\n`
    : '';
  const deviceStoreImport = features.deviceAuthorizationGrant
    ? `  deviceAuthorizationStore,\n`
    : '';
  // EXPERIMENTAL (CIBA Core 1.0): the backchannel authentication endpoint is a
  // back-channel, client-authenticated POST endpoint, so it gets the same CORS
  // policy as /token. The authentication device UI (/ciba...) is reached by
  // direct browser navigation, so it needs no CORS headers — the same treatment
  // as /login and /consent.
  const cibaImport = features.ciba
    ? `import { backchannelAuthenticationApp } from './routes/backchannel-authentication.js';
import { cibaPage } from './pages/ciba.js';\n`
    : '';
  const cibaCors = features.ciba
    ? `  app.use('/backchannel_authentication', protectedCors);\n`
    : '';
  const cibaMount = features.ciba
    ? `  app.route('/backchannel_authentication', backchannelAuthenticationApp);
  app.route('/ciba', cibaPage);\n`
    : '';
  // The default CIBA user resolver treats login_hint as the username of the
  // injected user store, so a custom storage option is honored without extra
  // wiring. options.cibaUserResolver overrides the whole resolution.
  const cibaStorageContext = features.ciba
    ? `    c.set('cibaAuthenticationRequestStore', cibaAuthenticationRequestStore);
    c.set('cibaLoginTransactionStore', cibaLoginTransactionStore);
    c.set('cibaUserResolver', options.cibaUserResolver ?? (async (loginHint: string) => {
      const claims = await stores.userStore.getClaims(loginHint);
      return claims ? { subject: claims.sub } : null;
    }));`
    : '';
  const cibaStoreImport = features.ciba
    ? `  cibaAuthenticationRequestStore,
  cibaLoginTransactionStore,\n`
    : '';
  const cibaOptionsField = features.ciba
    ? `  /**
   * EXPERIMENTAL (CIBA Core 1.0 §7.1): resolve a login_hint to the subject the
   * authentication request is for. Defaults to treating the hint as a username
   * of the configured user store. Return null when no user matches.
   */
  cibaUserResolver?: (
    loginHint: string,
  ) => Promise<{ subject: string } | null> | { subject: string } | null;
`
    : '';
  // EXPERIMENTAL (RP-Initiated Logout 1.0): the end_session_endpoint and its
  // confirmation screen are reached by direct browser navigation, so they need
  // no CORS headers — the same treatment as /login and /consent. The feature
  // adds no store: the session store and the id_token_hint JWKS provider are
  // already wired for every build.
  const logoutImport = features.rpInitiatedLogout
    ? `import { logoutPage } from './pages/logout.js';\n`
    : '';
  const logoutMount = features.rpInitiatedLogout
    ? `  app.route('/logout', logoutPage);\n`
    : '';
  // EXTENSION (google-login): the Google login callback needs the nonce store,
  // the ID token verifier (google-auth-library by default) and the resolver that
  // maps a verified Google account to an OP subject. The default resolver links
  // the account through the user store (just-in-time provisioning), so a custom
  // storage option is honored without extra wiring.
  const googleLoginImport = features.googleLogin
    ? `import {
  getDefaultGoogleIdTokenVerifier,
  type GoogleAccountResolver,
  type GoogleIdTokenPayload,
  type GoogleIdTokenVerifier,
} from '${GOOGLE_LOGIN_PACKAGE}';\n`
    : '';
  const googleLoginStorageContext = features.googleLogin
    ? `    c.set('googleLoginNonceStore', stores.googleLoginNonceStore);
    c.set('googleIdTokenVerifier', options.googleIdTokenVerifier ?? getDefaultGoogleIdTokenVerifier());
    c.set('googleAccountResolver', options.googleAccountResolver ?? {
      resolveSubject: async (account: GoogleIdTokenPayload) =>
        (await stores.userStore.linkGoogleAccount(account)).sub,
    });\n`
    : '';
  const googleLoginOptionsFields = features.googleLogin
    ? `  /**
   * EXTENSION (google-login): verifier for the ID token Google posts to
   * /login/google. Defaults to google-auth-library (OAuth2Client.verifyIdToken)
   * with a process-wide certificate cache; inject a custom one for tests or a
   * proxied environment.
   */
  googleIdTokenVerifier?: GoogleIdTokenVerifier;
  /**
   * EXTENSION (google-login): map a verified Google account to the OP subject.
   * Defaults to just-in-time provisioning through the user store
   * (userStore.linkGoogleAccount), keyed by the Google \`sub\`.
   */
  googleAccountResolver?: GoogleAccountResolver;
`
    : '';
  const refreshStorageContext = features.refreshToken
    ? `    c.set('refreshTokenResolver', storeResolvers.refreshTokenResolver);
    c.set('authenticationSessionResolver', storeResolvers.authenticationSessionResolver);\n`
    : '';
  const introspectionStorageContext = features.introspection
    ? `    c.set('introspectionAccessTokenResolver', storeResolvers.introspectionAccessTokenResolver);
    c.set('introspectionRefreshTokenResolver', storeResolvers.introspectionRefreshTokenResolver);\n`
    : '';
  const revocationStorageContext = features.revocation
    ? `    c.set('revocationResolvers', storeResolvers.revocationResolvers);\n`
    : '';
  const methodGuard = oidcMethodGuardTemplate(features);
  return `import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authorizePage } from './pages/authorize.js';
import { tokenApp } from './routes/token.js';
import { userinfoApp } from './routes/userinfo.js';
${introspectionImport}${revocationImport}${parImport}${deviceImport}${cibaImport}${logoutImport}import { jwksApp } from './routes/jwks.js';
import { discoveryApp } from './routes/discovery.js';
import { loginPage } from './pages/login.js';
import { consentPage } from './pages/consent.js';
import {
  createInMemoryClientResolver,
  createProviderConfig,
  type ProviderConfig,
} from './config.js';
import {
  createStoreResolvers,
} from './resolvers.js';
import {
${storageParts.defaultStoresImport}${parStoreImport}${deviceStoreImport}${cibaStoreImport}  type ProviderStores,
  type ProviderStoresFactory,
} from './store.js';
import { createViews, type Views } from './views.js';
${storageParts.dbImports}${googleLoginImport}import {
  assertHasRs256Key,
  assertKeyStrength,
  assertKidStrategyConsistent,
  signingKeysToJwkSet,
} from '${_corePkg}';
import type {
  SigningKey,
  SigningKeyProvider,
  ClientResolver,
  TokenClientResolver,
  AcrResolver,
  SessionResolver,
  ConsentResolver,
  JwkSet,
} from '${_corePkg}';

export type CorsOrigins = string | string[];

export interface CreateAppOptions {
  config?: Partial<ProviderConfig>;
  /**
   * Primary signing key provider. getSigningKeys() returns the registered
   * keys: the first one signs access tokens (JWT format), and every one is
   * published at the JWKS endpoint, so keep a rotated-out key after the new one
   * until the tokens it signed expire. Also used for ID Token / UserInfo
   * signing when their dedicated providers are not configured.
   * Must load keys from your secret store (env var, KV, D1, etc.).
   * Use createCachedSigningKeyProvider() to refresh the keys periodically.
   */
  signingKeyProvider: SigningKeyProvider;
  idTokenSigningKeyProvider?: SigningKeyProvider;
  userinfoSigningKeyProvider?: SigningKeyProvider;
  clientResolver?: ClientResolver;
  tokenClientResolver?: TokenClientResolver;
  /**
   * Session resolver used for SSO / prompt=none / max_age
   * (OIDC Core 1.0 Section 3.1.2.1 / 3.1.2.3).
   * Defaults to the cookie-based browser session resolver in resolvers.ts.
   */
  sessionResolver?: SessionResolver;
  /**
   * Consent resolver used by prompt=none to confirm prior consent without UI
   * (OIDC Core 1.0 Section 3.1.2.1).
   * Defaults to the in-memory consent store resolver in resolvers.ts.
   */
  consentResolver?: ConsentResolver;
  /** ${storageParts.storageDoc} */
  storage?: ProviderStores | ProviderStoresFactory;
  acrResolver?: AcrResolver;
  /**
   * Custom UI for the login / consent / error pages.
   * Provide any subset; omitted pages fall back to the default views.
   * Inject your own UI here instead of editing views.ts.
   */
  views?: Partial<Views>;
  /**
   * JWKS provider used to verify id_token_hint (OIDC Core 1.0 §3.1.2.2).
   * Omit to use the OP's own ID Token signing keys by default, so an ID Token
   * the OP issued can be presented back as id_token_hint without extra wiring.
   * Override only when hints are signed by a different key set.
   */
  jwksProvider?: () => Promise<JwkSet> | JwkSet;
${cibaOptionsField}${googleLoginOptionsFields}  corsOrigins?: CorsOrigins;
}

export function validateSigningKeySet(
  keys: readonly SigningKey[],
  requireRs256 = false,
): void {
  // The first key of a set signs new tokens, so a set needs at least one key.
  if (keys.length === 0) {
    throw new Error('Signing key set must contain at least one key');
  }
  assertKeyStrength(keys);
  assertKidStrategyConsistent(keys);
  if (requireRs256) {
    assertHasRs256Key(keys.map((key) => key.privateKey));
  }
}

${methodGuard}

/**
 * Initialize the OpenID Connect Provider.
 * Mounts middleware and routes onto the app instance.
 */
export function createApp(options: CreateAppOptions): Hono<{ Variables: Record<string, any> }> {
  // A factory must return an isolated router each time. Keeping this instance at
  // module scope makes later createApp calls reuse a matcher whose routes were
  // already finalized and also leaks the first call's middleware/options.
  const app = new Hono<{ Variables: Record<string, any> }>();
  const corsOrigins = options.corsOrigins ?? '*';
  const protectedCors = cors({
    origin: corsOrigins,
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  const publicCors = cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'], maxAge: 600 });
  app.use('/token', protectedCors);
  app.use('/userinfo', protectedCors);
${introspectionCors}${revocationCors}${parCors}${deviceCors}${cibaCors}  app.use('/.well-known/openid-configuration', publicCors);
  app.use('/.well-known/jwks.json', publicCors);
  // CORS must run first so OPTIONS preflights are answered before method enforcement.
  app.use('*', enforceOidcEndpointMethod);

  // Store runtime dependencies for use by routes.
  app.use('*', async (c, next) => {
    // T-022: each provider returns its registered key set. The first key of a
    // set signs new tokens, and every key is published at the JWKS endpoint so
    // rotated-out and alternate-alg keys stay verifiable.
    let signingKeys;
    let idTokenSigningKeys;
    let userinfoSigningKeys;
    try {
      signingKeys = await options.signingKeyProvider.getSigningKeys();
      // Each purpose-specific provider falls back to the primary one.
      const idProvider = options.idTokenSigningKeyProvider ?? options.signingKeyProvider;
      idTokenSigningKeys = await idProvider.getSigningKeys();
      const uiProvider = options.userinfoSigningKeyProvider ?? options.signingKeyProvider;
      userinfoSigningKeys = await uiProvider.getSigningKeys();
      validateSigningKeySet(signingKeys);
      validateSigningKeySet(idTokenSigningKeys, true);
      validateSigningKeySet(userinfoSigningKeys);
    } catch {
      return c.json({ error: 'server_error', error_description: 'Failed to load signing key' }, 503);
    }
    const clientResolver =
      options.clientResolver ?? createInMemoryClientResolver();
    const stores = await resolveProviderStores(options.storage, c);
    const storeResolvers = createStoreResolvers(stores);

    c.set('signingKeys', signingKeys);
    c.set('idTokenSigningKeys', idTokenSigningKeys);
    c.set('userinfoSigningKeys', userinfoSigningKeys);
    c.set('config', createProviderConfig(options.config));
    c.set('clientResolver', clientResolver);
    c.set('tokenClientResolver', options.tokenClientResolver ?? clientResolver);
    c.set('transactionStore', stores.transactionStore);
    c.set('authCodeStore', stores.authCodeStore);
    c.set('accessTokenStore', stores.accessTokenStore);
    c.set('refreshTokenStore', stores.refreshTokenStore);
    c.set('authSessionStore', stores.authSessionStore);
    c.set('browserSessionStore', stores.browserSessionStore);
    c.set('authenticateUser', (username: string, password: string) =>
      stores.userStore.authenticate(username, password));
    c.set('authCodeResolver', storeResolvers.authorizationCodeResolver);
    c.set('accessTokenResolver', storeResolvers.accessTokenResolver);
    c.set('userClaimsResolver', storeResolvers.userClaimsResolver);
${refreshStorageContext}${introspectionStorageContext}${revocationStorageContext}${parStorageContext}${deviceStorageContext}${cibaStorageContext}${googleLoginStorageContext}
    // P1: default cookie-based session + consent resolvers so prompt=none /
    // max_age / SSO work out of the box (OIDC Core 1.0 Section 3.1.2.1 / 3.1.2.3).
    c.set('sessionResolver', options.sessionResolver ?? storeResolvers.sessionResolver);
    c.set('consentResolver', options.consentResolver ?? storeResolvers.consentResolver);
    if (options.acrResolver) {
      c.set('acrResolver', options.acrResolver);
    }
    // Inject custom UI (login / consent / error) merged over the defaults.
    c.set('views', createViews(options.views));
    // Default jwksProvider verifies id_token_hint against the OP's own ID Token
    // signing keys (OIDC Core 1.0 §3.1.2.2) so a hint the OP issued validates out
    // of the box. An explicit options.jwksProvider overrides it. The closure
    // captures this request's key set so it reflects the latest rotation.
    c.set('jwksProvider', options.jwksProvider ?? (() => signingKeysToJwkSet(idTokenSigningKeys)));
    await next();
  });

  // Browser-facing surfaces are mounted from pages/: every GET and POST of a
  // screen lives there, and the logic they call is in routes/.
  app.route('/authorize', authorizePage);
  app.route('/token', tokenApp);
  app.route('/userinfo', userinfoApp);
${introspectionMount}${revocationMount}${parMount}${deviceMount}${cibaMount}${logoutMount}  app.route('/.well-known/jwks.json', jwksApp);
  app.route('/.well-known/openid-configuration', discoveryApp);
  app.route('/login', loginPage);
  app.route('/consent', consentPage);

  return app;
}

async function resolveProviderStores(
  storage: CreateAppOptions['storage'],
  context: any,
): Promise<ProviderStores> {
  if (!storage) return ${storageParts.defaultStores};
  return typeof storage === 'function' ? storage(context) : storage;
}
`;
}

/**
 * The modules scopes.ts points readers to. The defaults are the Hono / Express /
 * Fastify layout; the Next.js generator passes its own App Router paths.
 */
export interface ScopePolicyFileRefs {
  /** Where custom-scope UserInfo claims would be added. */
  userinfo: string;
  /** The consent step (screen and approval). */
  consent: string;
  /** The authorization endpoint (SSO fast path and prompt=none). */
  authorize: string;
  /** The device and CIBA approval steps. */
  approvals: string;
}

const DEFAULT_SCOPE_POLICY_FILE_REFS: ScopePolicyFileRefs = {
  userinfo: 'routes/userinfo.ts',
  consent: 'routes/consent.ts',
  authorize: 'routes/authorize.ts',
  approvals: 'routes/device.ts / routes/ciba-verification.ts',
};

/**
 * Generated `scopes.ts` — the custom scopes declared with `--scope`, plus the
 * per-End-User filtering seam. Emitted only when at least one custom scope was
 * declared, so an OP generated without them is byte-identical to before this
 * option existed.
 */
export function customScopesTemplate(
  scopes: string[],
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  fileRefs: ScopePolicyFileRefs = DEFAULT_SCOPE_POLICY_FILE_REFS,
): string {
  const toListLiteral = (values: string[]): string =>
    values.length === 0 ? '[]' : `[${values.map((value) => `'${singleQuoted(value)}'`).join(', ')}]`;
  // offline_access is a standard scope only where the refresh-token feature was
  // generated; with it disabled the OP never grants it (OIDC Core 1.0 §11), so
  // it must not reach scopes_supported either.
  const standardScopes = [
    'openid',
    'profile',
    'email',
    'address',
    'phone',
    ...(features.refreshToken ? ['offline_access'] : []),
  ];
  const exampleScope = scopes[0] ?? 'reports.read';
  return `/**
 * Scope policy for this provider.
 *
 * The custom scopes below were declared with the CLI's \`--scope\` option, and this
 * module is the single place the generated provider asks its two scope questions.
 * It deliberately imports nothing, so both answers can be rewritten — including
 * against a database — without touching a route.
 *
 * 1. "May this value be requested at all?" — \`findUnsupportedScopes()\`, called by
 *    the authorization endpoint (and by the device / CIBA request endpoints when
 *    those features are generated). A value that is neither standard nor declared
 *    here is rejected with \`invalid_scope\` (RFC 6749 §3.3 / §4.1.2.1).
 * 2. "May THIS End-User be granted it?" — \`resolveGrantableScopes()\`, called from
 *    every step that turns a request into a grant. **This is where per-user scope
 *    filtering goes**; see its doc comment below.
 *
 * Custom scopes carry no UserInfo claims of their own: OIDC Core 1.0 §5.4 defines
 * claims for profile / email / address / phone only, so \`filterClaimsByScope()\`
 * ignores them. Return your own claims for a custom scope by editing
 * ${fileRefs.userinfo}.
 */

/**
 * Scopes this provider implements itself and always accepts: \`openid\` (OIDC Core
 * 1.0 §3.1.2.1), the four claim scopes (§5.4)${features.refreshToken ? ' and `offline_access` (§11)' : ''}.
 */
export const STANDARD_SCOPES: readonly string[] = ${toListLiteral(standardScopes)};

/** Declared with \`--scope\`: the custom scopes this provider accepts. */
export const CUSTOM_SCOPES: readonly string[] = ${toListLiteral(scopes)};

/**
 * OIDC Discovery 1.0 §3 \`scopes_supported\`: every value this OP accepts. It is
 * OP metadata, so it lists what the provider supports — not what a particular
 * End-User ends up being granted, which resolveGrantableScopes() decides.
 */
export const SUPPORTED_SCOPES: readonly string[] = [...STANDARD_SCOPES, ...CUSTOM_SCOPES];

/**
 * Per-End-User scope restrictions, keyed by scope: only the listed subjects may
 * be granted that scope. Empty by default, so every accepted scope is grantable
 * to every authenticated End-User.
 *
 * This is the quickest way to restrict a scope — uncomment and fill in. For
 * anything richer (roles, tenants, a database), write it in
 * resolveGrantableScopes() below instead.
 */
export const RESTRICTED_SCOPE_SUBJECTS: Record<string, readonly string[]> = {
  // '${singleQuoted(exampleScope)}': ['testuser'],
};

/**
 * Narrow the requested scopes to what this End-User may actually be granted.
 *
 * **This is the per-user scope filtering seam.** It runs once the End-User is
 * known, and every step that decides a grant already awaits it:
 *
 * - ${fileRefs.consent} — the consent screen (what is displayed) and the approval
 *   (what is granted)
 * - ${fileRefs.authorize} — the SSO fast path and prompt=none, which grant without
 *   showing consent. Both narrow BEFORE looking up stored consent, because a
 *   consent lookup for a scope the subject can never hold would never match.
 * - ${fileRefs.approvals} — the device and CIBA approval
 *   steps, when those features are generated
 *
 * It is async so a database / KV lookup can be dropped in without touching any
 * call site. \`requested\` also carries the standard scopes, so a policy may
 * narrow those too.
 *
 * Dropping a scope narrows the grant rather than failing the request: RFC 6749
 * §3.3 lets the authorization server issue a scope narrower than the one asked
 * for, and the token response reports the granted \`scope\`. To refuse the whole
 * request instead, throw from the call site that suits your flow.
 */
export async function resolveGrantableScopes(
  requested: readonly string[],
  subject: string,
): Promise<string[]> {
  return requested.filter((scope) => {
    const allowedSubjects = RESTRICTED_SCOPE_SUBJECTS[scope];
    return allowedSubjects === undefined || allowedSubjects.includes(subject);
  });
}

/**
 * Requested scopes this OP does not accept at all. A non-empty result means the
 * request must be rejected with \`invalid_scope\` (RFC 6749 §3.3).
 */
export function findUnsupportedScopes(requested: readonly string[]): string[] {
  return requested.filter((scope) => !SUPPORTED_SCOPES.includes(scope));
}
`;
}

export function configTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const refreshTokenLifetimeField = features.refreshToken
    ? `  /**
   * Refresh token の absolute lifetime（秒）。初回発行時刻からの絶対的な有効期限。
   * OAuth 2.1 §6.1: refresh token rotation で sliding expiry を毎回延長すると、利用者が
   * リフレッシュし続ける限り RT が無期限に延び、漏洩 RT が長期間 abuse され得る。本実装は
   * sliding expiry を持たず、RT の expiresAt は initial issuance（originalIssuedAt）からの
   * この absolute lifetime のみで決まる。rotation しても失効時刻は前に進まない。
   * 設定例: 90 日 = 7776000。
   */
  refreshTokenAbsoluteLifetime: number;
  /**
   * online refresh token（\`offline_access\` が付与されていない grant にも発行する
   * Refresh Token）を有効にするか。
   *
   * OIDC Core 1.0 §11 は \`offline_access\` を「End-User が居ない（not logged in）ときにも
   * 使える Refresh Token」と定義したうえで、Refresh Token の利用がその用途に限られない
   * ことを明示している（"The use of Refresh Tokens is not exclusive to the
   * \`offline_access\` use case. The Authorization Server MAY grant Refresh Tokens in
   * other contexts that are beyond the scope of this specification."）。本 OP はその
   * 「other contexts」を online refresh token として実装する。
   *
   * - \`true\`（既定）: \`grant_types\` に \`refresh_token\` を登録したクライアントには、
   *   \`offline_access\` が無くても Refresh Token を発行する。ただし発行元のログイン
   *   セッションへ束縛され、セッションが終われば \`invalid_grant\` になる。ブラウザ
   *   セッションを持たない経路（device authorization grant）では発行しない。
   * - \`false\`: Refresh Token は \`offline_access\` が付与された grant にだけ発行する。
   *   ログアウトしても使い続けられる offline refresh token だけになる。
   */
  onlineRefreshTokenEnabled: boolean;
`
    : '';
  const refreshTokenLifetimeDefault = features.refreshToken
    ? `  // OAuth 2.1 §6.1: refresh token は initial issuance から 90 日（7776000 秒）で必ず失効する。
  refreshTokenAbsoluteLifetime: 7776000,
  // OIDC Core 1.0 §11: offline_access 無しの Refresh Token（online refresh token）も
  // 発行する。ログインセッションに束縛されるため、ログアウトすると使えなくなる。
  onlineRefreshTokenEnabled: true,
`
    : '';
  const allowNonPkceDefault = features.pkce
    ? `  allowNonPkceAuthorizationCodeFlow: false,
`
    : `  // Generated with the pkce feature disabled: PKCE is optional for explicit
  // confidential clients (public clients and malformed PKCE values are still rejected).
  allowNonPkceAuthorizationCodeFlow: true,
`;
  const allowUnsignedField = features.requestObject
    ? `  /**
   * OIDC Core 1.0 §6.1: 署名無し（\`alg: "none"\`）Request Object を互換受理するか。
   * 既定は false（署名付き Request Object のみ受理）。OIDF Conformance Suite の一部
   * module は unsigned Request Object を送るため、Basic OP conformance 互換のときだけ
   * true にする。true の場合は discovery の request_object_signing_alg_values_supported に
   * "none" も広告される。
   */
  allowUnsignedRequestObject: boolean;
`
    : '';
  const allowUnsignedDefault = features.requestObject
    ? `  // OIDC Core 1.0 §6.1: require signed Request Objects by default; enable only for
  // Basic OP conformance compatibility where the suite sends unsigned ones.
  allowUnsignedRequestObject: false,
`
    : '';
  // Same assembly rule as discovery: a disabled feature adds nothing, so the
  // default generation is unchanged.
  const exampleClientGrantTypes = [
    `'authorization_code'`,
    ...(features.refreshToken ? [`'refresh_token'`] : []),
    // EXPERIMENTAL (ID-JAG draft §4.3): requesting an ID-JAG is a token-exchange
    // request, so enabling id-jag alone also registers the exchange URN.
    ...(features.tokenExchange || features.idJag
      ? [`'urn:ietf:params:oauth:grant-type:token-exchange'`]
      : []),
    ...(features.idJag ? [`'urn:ietf:params:oauth:grant-type:jwt-bearer'`] : []),
    // EXPERIMENTAL (CIBA Core 1.0 §7.1): registering the CIBA URN is what lets
    // this confidential client start backchannel authentication requests.
    ...(features.ciba ? [`'urn:openid:params:grant-type:ciba'`] : []),
  ].join(', ');
  const exampleClientExchangeComment = features.tokenExchange
    ? `      // EXPERIMENTAL (RFC 8693): registering the token-exchange URN is what lets
      // this confidential client exchange its access tokens. Remove it to forbid
      // exchanges for this client; public clients are rejected either way.
`
    : '';
  const exampleClientIdJagComment = features.idJag
    ? `      // EXPERIMENTAL (ID-JAG draft §4.3 / §4.4): the token-exchange URN lets this
      // confidential client request an ID-JAG for a trusted resource authorization
      // server, and the jwt-bearer URN lets it redeem an ID-JAG issued by a trusted
      // identity provider. Remove either to forbid that half of Cross-App Access.
`
    : '';
  const exampleClientCibaComment = features.ciba
    ? `      // EXPERIMENTAL (CIBA Core 1.0 §7.1): registering the CIBA URN is what lets
      // this confidential client POST /backchannel_authentication and poll the
      // token endpoint with the resulting auth_req_id. Remove it to forbid CIBA
      // for this client; public clients are rejected either way.
`
    : '';
  const noRefreshGrantComment = features.tokenExchange
    ? `      // RFC 7591 §2: grant_types default is ["authorization_code"]. The refresh_token
      // grant is disabled in this generated provider, so it is not registered.
`
    : `      // RFC 7591 §2: grant_types default is ["authorization_code"]. The refresh_token
      // grant is disabled in this generated provider, so only authorization_code is registered.
`;
  // EXPERIMENTAL (CIBA Core 1.0 §4): backchannel_token_delivery_mode client
  // metadata. This provider only offers poll, so registering ping or push makes
  // every backchannel authentication request fail with unauthorized_client.
  // Omitted means poll.
  const cibaClientField = features.ciba
    ? `
  backchannelTokenDeliveryMode?: 'poll' | 'ping' | 'push';`
    : '';
  const exampleClientGrantFields = features.refreshToken
    ? `      // RFC 7591 §2: grant_types default is ["authorization_code"]. Registering
      // refresh_token is the single switch that lets this client receive refresh
      // tokens at all: an online refresh token (bound to the login session) on every
      // authorization, and an offline one (usable after logout) when offline_access
      // is granted per OIDC Core 1.0 §11. Remove it and neither is issued.
${exampleClientExchangeComment}${exampleClientIdJagComment}${exampleClientCibaComment}      grantTypes: [${exampleClientGrantTypes}],
`
    : `${noRefreshGrantComment}${exampleClientExchangeComment}${exampleClientIdJagComment}${exampleClientCibaComment}      grantTypes: [${exampleClientGrantTypes}],
`;
  // EXTENSION (google-login): Sign in with Google settings. Optional, so an OP
  // generated with the feature still boots without a Google client and simply
  // renders no button until config.googleLogin is set.
  const googleLoginConfigTypes = features.googleLogin
    ? `
/**
 * EXTENSION (google-login): Sign in with Google (Google Identity Services,
 * redirect mode) as a login method. See @maronn-openid-connect/google-login.
 */
export interface GoogleLoginConfig {
  /**
   * OAuth 2.0 client ID (type: Web application) from the Google Cloud console.
   * The ID token's \`aud\` must equal it. Register \`<issuer>/login/google\` as an
   * authorized redirect URI of this client, and the login page origin as an
   * authorized JavaScript origin.
   */
  clientId: string;
  /**
   * Optional: only accept Google Workspace accounts of these hosted domains
   * (\`hd\` claim). A personal Google account has no \`hd\` and is rejected.
   */
  hostedDomain?: string | string[];
  /**
   * Optional: reject accounts whose email Google has not verified
   * (\`email_verified !== true\`). Off by default; users are keyed by the Google
   * \`sub\`, never by email, so an unverified email cannot hijack another user.
   */
  requireVerifiedEmail?: boolean;
}
`
    : '';
  const googleLoginConfigField = features.googleLogin
    ? `  /**
   * EXTENSION (google-login): Sign in with Google. Leave undefined to render no
   * Google button; the login page then only offers the username / password form.
   */
  googleLogin?: GoogleLoginConfig;
`
    : '';
  return `import type {
  ClientInfo,
  ClientResolver,
  TokenClientInfo,
  TokenClientResolver,
} from '${corePkg}';
${googleLoginConfigTypes}
export interface ProviderConfig {
  issuer: string;
  accessTokenExpiresIn: number;
  idTokenExpiresIn: number;
${refreshTokenLifetimeField}  /**
   * アクセストークンの形式。
   * - 'jwt' (デフォルト): 自己完結。ステートレス検証可能だが即時失効が困難。
   * - 'opaque'         : 不透明文字列。リソースサーバは Introspection / ストア参照で検証。
   *                      Revocation との相性が良く、即時失効が必要なケースに向く。
   */
  accessTokenFormat: 'jwt' | 'opaque';
  /**
   * Authorization code の有効期間（秒）。OIDC Core 1.0 §3.1.3.1 は authorization code を
   * short-lived にすることを求めており（推奨上限 10 分）、本ライブラリは core helper の
   * デフォルトと同じ 300 秒（5 分）を既定値とする。PoC でタイムアウト挙動を確認したい場合は
   * この値を縮めて検証できる。
   */
  authorizationCodeTtl: number;
  /**
   * OpenID Foundation Basic OP static-client conformance 互換モード。
   * false の場合はOAuth 2.1方針としてPKCE(S256)を必須にする。true の場合でも
   * core 側は明示的な confidential client の完全な非PKCE requestだけを許可し、
   * 不正なPKCE値やpublic clientの非PKCE requestは拒否する。
   */
  allowNonPkceAuthorizationCodeFlow: boolean;
${allowUnsignedField}${googleLoginConfigField}}

/**
 * Optional defaults for quick local testing.
 * Production code should create ProviderConfig from environment variables,
 * KV, D1, or another project-owned configuration source.
 */
export const defaultProviderConfig: ProviderConfig = {
  issuer: 'http://localhost:3000',
  accessTokenExpiresIn: 3600,
  idTokenExpiresIn: 3600,
${refreshTokenLifetimeDefault}  accessTokenFormat: 'jwt',
  // OIDC Core 1.0 §3.1.3.1: authorization code は short-lived であるべき（5 分 = 300 秒）。
  authorizationCodeTtl: 300,
${allowNonPkceDefault}${allowUnsignedDefault}};

export function createProviderConfig(
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    ...defaultProviderConfig,
    ...overrides,
  };
}

/**
 * Extended client info for this provider.
 *
 * Whether a client may receive refresh tokens is decided by the standard
 * \`grantTypes\` registration metadata (RFC 7591 §2 / OIDC Dynamic Client
 * Registration 1.0 §2) it already carries through TokenClientInfo — there is no
 * separate provider-specific switch. \`grantTypes\` containing \`refresh_token\`
 * gates both refresh token flavors; OIDC Core 1.0 §11 (prompt=consent) decides
 * which flavor the authorization produces.
 *
 * userinfoSignedResponseAlg: when set, the UserInfo endpoint returns a signed JWT
 * with content-type \`application/jwt\` (OIDC Core 1.0 Section 5.3.2 — client metadata
 * \`userinfo_signed_response_alg\`). The endpoint picks a registered UserInfo signing
 * key whose alg matches this value (mirroring idTokenSignedResponseAlg), so the
 * response is signed with the requested alg — not limited to RS256. A request whose
 * alg has no registered key is rejected as a server configuration error.
 *
 * idTokenSignedResponseAlg: chooses the JWA alg for this client's ID Token
 * (OIDC Dynamic Client Registration 1.0 §2 — client metadata
 * \`id_token_signed_response_alg\`). When omitted, the OIDC default \`RS256\` is used.
 * The token endpoint picks an actual signing key matching this alg from the
 * registered ID Token key set; a request whose alg has no registered key is
 * rejected as a server configuration error.
 */
export type RegisteredClient = ClientInfo & TokenClientInfo & {
  userinfoSignedResponseAlg?: 'RS256' | 'ES256';
  idTokenSignedResponseAlg?: 'RS256' | 'ES256';${cibaClientField}
};

/**
 * Optional in-memory defaults for quick local testing only.
 * Prefer D1, KV, or another project-owned client resolver in real projects.
 */
export const defaultRegisteredClients: ReadonlyMap<string, RegisteredClient> = new Map([
  [
    'example-client',
    {
      clientId: 'example-client',
      clientSecret: 'example-secret',
      redirectUris: ['http://localhost:3000/callback'],
      clientType: 'confidential' as const,
${exampleClientGrantFields}      // RFC 7591 §2: token_endpoint_auth_method default is client_secret_basic.
      // The sample client authenticates with client_secret_post, so register it explicitly.
      tokenEndpointAuthMethod: 'client_secret_post',
      // OIDC Dynamic Client Registration 1.0 §2: default_max_age (seconds).
      // When the authorization request omits max_age, the OP applies this as the
      // default re-authentication freshness. A request-supplied max_age overrides it.
      defaultMaxAge: 3600,
    },
  ],
]);

export function createInMemoryClientResolver(
  clients: ReadonlyMap<string, RegisteredClient> = defaultRegisteredClients,
): ClientResolver & TokenClientResolver {
  return {
    async findClient(clientId: string): Promise<RegisteredClient | null> {
      return clients.get(clientId) ?? null;
    },
  };
}
`;
}

export function storeTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const parStoreTypeImport = features.par
    ? `
import type {
  PushedAuthorizationRecord,
  PushedAuthorizationRequestStore,
} from '${EXPERIMENTAL_PACKAGE}/par';`
    : '';
  const parStoreImplementation = features.par
    ? `
/**
 * EXPERIMENTAL — in-memory Pushed Authorization Request store (RFC 9126).
 *
 * Replace with a persistent store (Redis, KV, database) in production. The
 * contract is only two methods:
 *
 * - save(record): persist the pushed request, ideally with a TTL matching
 *   record.expiresAt so entries cannot pile up (RFC 9126 §7.3).
 * - consume(requestUri): fetch AND delete in one atomic operation. A
 *   non-atomic implementation lets the same request_uri be replayed
 *   concurrently. Treat requestUri as an opaque external value: never
 *   interpolate it into a query, always bind it as a parameter.
 */
export class InMemoryPushedAuthorizationRequestStore
  implements PushedAuthorizationRequestStore
{
  private records = new Map<string, PushedAuthorizationRecord>();

  async save(record: PushedAuthorizationRecord): Promise<void> {
    this.records.set(record.requestUri, record);
  }

  async consume(requestUri: string): Promise<PushedAuthorizationRecord | null> {
    const record = this.records.get(requestUri);
    // Single use (RFC 9126 §7.3): delete on read, expired or not, so a replay of
    // the same reference can never succeed.
    this.records.delete(requestUri);
    if (!record) {
      this.evictExpired();
      return null;
    }
    return record;
  }

  /** Drop entries whose lifetime has passed so an idle store cannot grow unbounded. */
  private evictExpired(): void {
    const now = Date.now();
    for (const [requestUri, record] of this.records) {
      if (record.expiresAt.getTime() < now) {
        this.records.delete(requestUri);
      }
    }
  }
}

// Kept on globalThis for the same reason as the provider stores above: Next.js
// instantiates route handlers and server actions in separate module layers.
const parStoreRegistry = globalThis as typeof globalThis & {
  __oidcPushedAuthorizationRequestStore?: PushedAuthorizationRequestStore;
};

export const parStore: PushedAuthorizationRequestStore =
  (parStoreRegistry.__oidcPushedAuthorizationRequestStore ??=
    new InMemoryPushedAuthorizationRequestStore());
`
    : '';
  const deviceStoreTypeImport = features.deviceAuthorizationGrant
    ? `
import type {
  DeviceAuthorizationRecord,
  DeviceAuthorizationStore,
} from '${EXPERIMENTAL_PACKAGE}/device-authorization-grant';`
    : '';
  const deviceStoreImplementation = features.deviceAuthorizationGrant
    ? `
/**
 * EXPERIMENTAL — device verification binding cookie (RFC 8628 §5.4 / §3.3).
 *
 * Why this exists: the user_code is, by design, known to whoever started the
 * device flow — and that party can be the attacker. A CSRF token that hangs off
 * the record is therefore worthless on its own: the attacker POSTs /device with
 * their own code, reads the token, and can then forge \`POST /device/approve\`
 * (consent coercion: the victim's tokens land on the attacker's device) or
 * \`POST /device/login\` (login CSRF: the victim's browser gets the attacker's
 * OP session). Neither is stopped by keeping the token secret.
 *
 * The binding is what stops them. On a successful user_code match the OP mints a
 * bindingSecret, hands the raw value to that one browser in an HttpOnly cookie,
 * and stores only its SHA-256 hash on the record. /device/login and
 * /device/approve refuse to run unless the presented cookie hashes to the stored
 * value, so a forged cross-site POST — which cannot carry the victim's cookie
 * (SameSite=Lax), and whose victim never held this record's cookie anyway — is
 * rejected without relying on any secret staying secret.
 *
 * The authorize flow does not need this: its transaction id never leaves the
 * OP except in the HttpOnly transaction cookie, so the cookie itself is the
 * binding. Here the identifier is public to the attacker by construction, so a
 * separate secret has to be handed out once the code matches. Like the authorize
 * flow, driving the verification UI by hand with curl needs a cookie jar
 * (-c / -b).
 *
 * The cookie name embeds the normalized user_code so two device flows can run in
 * the same browser without overwriting each other's secret.
 */
export const DEVICE_BINDING_COOKIE_PREFIX = 'oidc_device_';

/**
 * Build the Set-Cookie value binding one device verification to this browser.
 * Same attributes as the session cookie: HttpOnly (no JS access), Secure (HTTPS
 * only; http://localhost is treated as trustworthy by browsers) and
 * SameSite=Lax. Max-Age matches the remaining record TTL so an abandoned
 * verification does not leave a cookie behind.
 */
export function buildDeviceBindingCookie(
  userCode: string,
  bindingSecret: string,
  ttlSeconds: number,
): string {
  return (
    DEVICE_BINDING_COOKIE_PREFIX + userCode + '=' + bindingSecret +
    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + String(ttlSeconds)
  );
}

/**
 * Build the Set-Cookie value that clears the binding cookie once the user has
 * approved or denied, so the browser does not accumulate one cookie per flow.
 */
export function buildClearedDeviceBindingCookie(userCode: string): string {
  return (
    DEVICE_BINDING_COOKIE_PREFIX + userCode +
    '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  );
}

/**
 * Extract the binding secret for one device verification from a Cookie header.
 * Returns null when the header is missing or this record's cookie is absent,
 * which validateVerificationBinding() rejects with 403.
 */
export function parseDeviceBindingSecret(
  cookieHeader: string | null,
  userCode: string,
): string | null {
  if (!cookieHeader) return null;
  const name = DEVICE_BINDING_COOKIE_PREFIX + userCode;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}

/**
 * EXPERIMENTAL — in-memory device authorization store (RFC 8628).
 *
 * Replace with a persistent store (Redis, KV, database) in production. Treat
 * deviceCode and userCode as opaque external values: never interpolate them into
 * a query, always bind them as parameters.
 *
 * - save / update: persist the record, ideally with a TTL derived from
 *   record.expiresAt so entries cannot pile up.
 * - consume(deviceCode): fetch AND delete in one atomic operation. A non-atomic
 *   implementation lets the same device_code be redeemed concurrently.
 * - Expired records whose device stopped polling are never reclaimed by the
 *   token endpoint. A persistent implementation MAY drop them on its own after a
 *   grace period (roughly one TTL); polling after that answers invalid_grant
 *   instead of expired_token, which ends the client's flow just the same.
 */
export class InMemoryDeviceAuthorizationStore implements DeviceAuthorizationStore {
  private records = new Map<string, DeviceAuthorizationRecord>();

  async save(record: DeviceAuthorizationRecord): Promise<void> {
    this.evictExpired();
    this.records.set(record.deviceCode, record);
  }

  async findByDeviceCode(deviceCode: string): Promise<DeviceAuthorizationRecord | null> {
    return this.records.get(deviceCode) ?? null;
  }

  async findByUserCode(userCode: string): Promise<DeviceAuthorizationRecord | null> {
    for (const record of this.records.values()) {
      if (record.userCode === userCode) return record;
    }
    return null;
  }

  async update(record: DeviceAuthorizationRecord): Promise<void> {
    this.records.set(record.deviceCode, record);
  }

  async delete(deviceCode: string): Promise<void> {
    this.records.delete(deviceCode);
  }

  async consume(deviceCode: string): Promise<DeviceAuthorizationRecord | null> {
    const record = this.records.get(deviceCode) ?? null;
    // Single use (RFC 8628 §3.5): delete on read so a replay of the same
    // device_code can never mint a second token.
    this.records.delete(deviceCode);
    return record;
  }

  /**
   * Drop records whose lifetime passed long enough ago that no device is still
   * polling them, so an idle store cannot grow unbounded. The grace period keeps
   * expired_token answerable for one more TTL after expiry.
   */
  private evictExpired(): void {
    const cutoff = Date.now() - DEVICE_RECORD_EVICTION_GRACE_MS;
    for (const [deviceCode, record] of this.records) {
      if (record.expiresAt.getTime() < cutoff) {
        this.records.delete(deviceCode);
      }
    }
  }
}

/** Grace period before an expired record is reclaimed (one default TTL). */
const DEVICE_RECORD_EVICTION_GRACE_MS = 600 * 1000;

// Kept on globalThis for the same reason as the provider stores above: Next.js
// instantiates route handlers and server actions in separate module layers.
const deviceStoreRegistry = globalThis as typeof globalThis & {
  __oidcDeviceAuthorizationStore?: DeviceAuthorizationStore;
};

export const deviceAuthorizationStore: DeviceAuthorizationStore =
  (deviceStoreRegistry.__oidcDeviceAuthorizationStore ??=
    new InMemoryDeviceAuthorizationStore());
`
    : '';
  const cibaStoreTypeImport = features.ciba
    ? `
import {
  createInMemoryCibaAuthenticationRequestStore,
  createInMemoryCibaLoginTransactionStore,
  type CibaAuthenticationRequestStore,
  type CibaLoginTransactionStore,
} from '${EXPERIMENTAL_PACKAGE}/ciba';`
    : '';
  const cibaStoreImplementation = features.ciba
    ? `
/**
 * EXPERIMENTAL — CIBA login transaction binding cookie (CIBA Core 1.0; the
 * authentication device UI itself is outside the spec's scope, §7.1).
 *
 * Why this exists: a successful login on /ciba/login establishes an OP session,
 * whose reach goes beyond CIBA (SSO, prompt=none). A hidden csrf_token alone
 * cannot stop login CSRF: the attacker fetches their own /ciba login form,
 * reads a valid login_transaction_id + csrf_token pair, and embeds both in a
 * forged cross-site POST — planting the attacker's session in the victim's
 * browser. What stops it is this cookie: the login form response binds the
 * transaction to the browser that requested it by handing that one browser the
 * raw bindingSecret in an HttpOnly cookie while the transaction stores only its
 * SHA-256 hash. A forged POST cannot carry the victim's cookie (SameSite=Lax),
 * and the victim never held this transaction's cookie anyway.
 *
 * The cookie name embeds the transaction id so two login forms can run in the
 * same browser without overwriting each other's secret.
 */
export const CIBA_LOGIN_BINDING_COOKIE_PREFIX = 'oidc_ciba_login_';

/**
 * Build the Set-Cookie value binding one CIBA login transaction to this
 * browser. Same attributes as the session cookie: HttpOnly (no JS access),
 * Secure (HTTPS only; http://localhost is treated as trustworthy by browsers)
 * and SameSite=Lax. Max-Age matches the transaction TTL so an abandoned login
 * form does not leave a cookie behind.
 */
export function buildCibaLoginBindingCookie(
  transactionId: string,
  bindingSecret: string,
  ttlSeconds: number,
): string {
  return (
    CIBA_LOGIN_BINDING_COOKIE_PREFIX + transactionId + '=' + bindingSecret +
    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + String(ttlSeconds)
  );
}

/**
 * Build the Set-Cookie value that clears the binding cookie once the login
 * succeeded, so the browser does not accumulate one cookie per login form.
 */
export function buildClearedCibaLoginBindingCookie(transactionId: string): string {
  return (
    CIBA_LOGIN_BINDING_COOKIE_PREFIX + transactionId +
    '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  );
}

/**
 * Extract the binding secret for one CIBA login transaction from a Cookie
 * header. Returns null when the header is missing or this transaction's cookie
 * is absent, which validateCibaLoginSubmission() rejects with 403.
 */
export function parseCibaLoginBindingSecret(
  cookieHeader: string | null,
  transactionId: string,
): string | null {
  if (!cookieHeader) return null;
  const name = CIBA_LOGIN_BINDING_COOKIE_PREFIX + transactionId;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}

// EXPERIMENTAL — CIBA stores. The in-memory implementations ship with
// ${EXPERIMENTAL_PACKAGE}/ciba; replace them with persistent stores (Redis, KV,
// database) in production. Treat authReqId and the login transaction id as
// opaque external values: never interpolate them into a query, always bind
// them as parameters. Kept on globalThis for the same reason as the provider
// stores above: Next.js instantiates route handlers and server actions in
// separate module layers.
const cibaStoreRegistry = globalThis as typeof globalThis & {
  __oidcCibaAuthenticationRequestStore?: CibaAuthenticationRequestStore;
  __oidcCibaLoginTransactionStore?: CibaLoginTransactionStore;
};

export const cibaAuthenticationRequestStore: CibaAuthenticationRequestStore =
  (cibaStoreRegistry.__oidcCibaAuthenticationRequestStore ??=
    createInMemoryCibaAuthenticationRequestStore());

export const cibaLoginTransactionStore: CibaLoginTransactionStore =
  (cibaStoreRegistry.__oidcCibaLoginTransactionStore ??=
    createInMemoryCibaLoginTransactionStore());
`
    : '';
  // EXTENSION (google-login): nonce store contract + verified account payload.
  const googleLoginStoreTypeImport = features.googleLogin
    ? `
import type {
  GoogleIdTokenPayload,
  GoogleLoginNonceRecord,
  GoogleLoginNonceStore,
} from '${GOOGLE_LOGIN_PACKAGE}';`
    : '';
  const googleUsersField = features.googleLogin
    ? `  // EXTENSION (google-login): users provisioned from a verified Google account,
  // keyed by their OP subject ('google:' + Google sub). They have no password.
  private googleUsers = new Map<string, UserClaims>();

`
    : '';
  const userStoreGoogleFallback = features.googleLogin ? 'this.googleUsers.get(sub)' : 'undefined';
  const userStoreGoogleMethods = features.googleLogin
    ? `
  /**
   * EXTENSION (google-login): create or refresh the OP user for a verified Google
   * account (just-in-time provisioning) and return its claims. The subject is
   * 'google:' + the Google sub — never the email, which a Google account can
   * change — so the same person always maps to the same OP user.
   */
  linkGoogleAccount(account: GoogleIdTokenPayload): UserClaims {
    const claims = googleAccountToClaims(account);
    this.googleUsers.set(claims.sub, claims);
    return claims;
  }
`
    : '';
  const googleLoginStoreImplementation = features.googleLogin
    ? `/**
 * EXTENSION (google-login): OP subject prefix for users provisioned from Google.
 */
export const GOOGLE_SUBJECT_PREFIX = 'google:';

/**
 * EXTENSION (google-login): the OP user record derived from a verified Google
 * ID token. Only the profile / email claims Google supplied are copied, so the
 * UserInfo endpoint returns exactly what Google asserted about the account.
 */
export function googleAccountToClaims(account: GoogleIdTokenPayload): UserClaims {
  const claims: UserClaims = { sub: GOOGLE_SUBJECT_PREFIX + account.sub };
  if (account.name !== undefined) claims.name = account.name;
  if (account.given_name !== undefined) claims.given_name = account.given_name;
  if (account.family_name !== undefined) claims.family_name = account.family_name;
  if (account.picture !== undefined) claims.picture = account.picture;
  if (account.locale !== undefined) claims.locale = account.locale;
  if (account.email !== undefined) claims.email = account.email;
  if (account.email_verified !== undefined) claims.email_verified = account.email_verified;
  return claims;
}

/**
 * EXTENSION (google-login): in-memory store for the nonce that binds a
 * "Sign in with Google" click to the authorization transaction it started from
 * (see @maronn-openid-connect/google-login). An entry lives as long as its
 * transaction and is consumed on first use by the callback.
 */
export class InMemoryGoogleLoginNonceStore implements GoogleLoginNonceStore {
  private records = new Map<string, { value: GoogleLoginNonceRecord; expiresAt: number }>();

  async get(key: string): Promise<GoogleLoginNonceRecord | null> {
    const entry = this.records.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.records.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: GoogleLoginNonceRecord, ttlSeconds: number): Promise<void> {
    this.records.set(key, { value, expiresAt: Date.now() + (ttlSeconds * 1000) });
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }
}

`
    : '';
  const userStorageGoogleMember = features.googleLogin
    ? `  /** EXTENSION (google-login): provision / refresh the user for a verified Google account. */
  linkGoogleAccount(account: GoogleIdTokenPayload): Awaitable<UserClaims>;
`
    : '';
  const providerStoresGoogleMember = features.googleLogin
    ? `  /** EXTENSION (google-login): nonce -> transaction binding for the Google callback. */
  googleLoginNonceStore: GoogleLoginNonceStore;
`
    : '';
  const googleLoginPrefixes = features.googleLogin
    ? `
const GOOGLE_USER_PREFIX = 'google-user:';
const GOOGLE_LOGIN_NONCE_PREFIX = 'google-login-nonce:';`
    : '';
  const jsonUserStoreGoogleFallback = features.googleLogin ? 'this.findGoogleUser(sub)' : 'undefined';
  const jsonUserStoreGoogleMethods = features.googleLogin
    ? `
  /**
   * EXTENSION (google-login): provision / refresh the user for a verified Google
   * account under its own key prefix, so it never collides with a password user.
   */
  async linkGoogleAccount(account: GoogleIdTokenPayload): Promise<UserClaims> {
    const claims = googleAccountToClaims(account);
    await this.backend.put(GOOGLE_USER_PREFIX + claims.sub, claims);
    return claims;
  }

  private async findGoogleUser(sub: string): Promise<UserClaims | undefined> {
    return (await this.backend.get<UserClaims>(GOOGLE_USER_PREFIX + sub)) ?? undefined;
  }
`
    : '';
  const jsonGoogleNonceStore = features.googleLogin
    ? `class JsonGoogleLoginNonceStore implements GoogleLoginNonceStore {
  constructor(private readonly backend: JsonStoreBackend) {}

  async get(key: string): Promise<GoogleLoginNonceRecord | null> {
    return this.backend.get<GoogleLoginNonceRecord>(GOOGLE_LOGIN_NONCE_PREFIX + key);
  }

  async put(key: string, value: GoogleLoginNonceRecord, ttlSeconds: number): Promise<void> {
    await this.backend.put(GOOGLE_LOGIN_NONCE_PREFIX + key, value, ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.backend.delete(GOOGLE_LOGIN_NONCE_PREFIX + key);
  }
}

`
    : '';
  const jsonStoresGoogleEntry = features.googleLogin
    ? `    googleLoginNonceStore: new JsonGoogleLoginNonceStore(backend),
`
    : '';
  const defaultStoresGoogleEntry = features.googleLogin
    ? `  googleLoginNonceStore: new InMemoryGoogleLoginNonceStore(),
`
    : '';
  const googleLoginStoreExport = features.googleLogin
    ? `
export const googleLoginNonceStore = defaultProviderStores.googleLoginNonceStore;`
    : '';
  // EXPERIMENTAL (RP-Initiated Logout 1.0): the logout confirmation cookie
  // helpers and the session-clearing Set-Cookie builder. Generated only with
  // --enable rp-initiated-logout so the default store.ts stays byte-identical.
  const rpInitiatedLogoutHelpers = features.rpInitiatedLogout
    ? `
/**
 * EXPERIMENTAL — RP-Initiated Logout confirmation cookie
 * (RP-Initiated Logout 1.0 §2).
 *
 * Rendering the logout confirmation screen mints a fresh secret and hands it
 * to that one browser twice: in this HttpOnly cookie and in the form's hidden
 * csrf_token. POST /logout/approve runs only when both come back carrying the
 * same secret. An attacker can collect a valid pair in their own browser, but
 * cannot set this cookie in the victim's browser, so a forged cross-site POST
 * fails the comparison (and SameSite=Lax drops the cookie from a cross-site
 * POST to begin with). Neither half alone is ever accepted — the same model
 * as the device verification binding cookie above.
 *
 * The cookie also carries the OP-computed post-logout redirect target
 * (base64url of the exact registered URL, or empty when there is none), so
 * the redirect decision survives the confirmation round-trip inside an
 * HttpOnly channel instead of a tamperable hidden form field — and the
 * id_token_hint itself is never echoed into the page.
 */
export const LOGOUT_CONFIRMATION_COOKIE = 'oidc_logout_confirm';

/** What one rendered confirmation screen carries across to its approve POST. */
export interface LogoutConfirmation {
  /** Secret pairing the HttpOnly cookie with the form's hidden csrf_token. */
  csrfSecret: string;
  /** Registered redirect URL resolved at render time, or null for the completed page. */
  redirectTo: string | null;
}

export function buildLogoutConfirmationCookie(confirmation: LogoutConfirmation): string {
  const bytes = new TextEncoder().encode(confirmation.redirectTo ?? '');
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  const encodedRedirect = btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  return (
    LOGOUT_CONFIRMATION_COOKIE + '=' + confirmation.csrfSecret + '.' + encodedRedirect +
    // 10 minutes: enough to read the screen and click, short enough that an
    // abandoned confirmation does not leave a long-lived pre-auth cookie.
    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600'
  );
}

/** Clear the confirmation cookie once the approve POST consumed it. */
export function buildClearedLogoutConfirmationCookie(): string {
  return LOGOUT_CONFIRMATION_COOKIE + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

/**
 * Parse the confirmation cookie back. Returns null when the cookie is absent
 * or malformed in any way, which the approve POST answers with 400 and,
 * crucially, without deleting anything.
 */
export function parseLogoutConfirmation(cookieHeader: string | null): LogoutConfirmation | null {
  if (!cookieHeader) return null;
  let value: string | null = null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === LOGOUT_CONFIRMATION_COOKIE) {
      value = trimmed.slice(eq + 1);
      break;
    }
  }
  if (value === null) return null;
  const dot = value.indexOf('.');
  if (dot === -1) return null;
  const csrfSecret = value.slice(0, dot);
  if (csrfSecret === '') return null;
  const encodedRedirect = value.slice(dot + 1);
  if (encodedRedirect === '') return { csrfSecret, redirectTo: null };
  if (!/^[A-Za-z0-9_-]+$/.test(encodedRedirect)) return null;
  try {
    const base64 = encodedRedirect.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return { csrfSecret, redirectTo: new TextDecoder().decode(bytes) };
  } catch {
    return null;
  }
}

/**
 * Build the Set-Cookie value that removes the browser session cookie. The
 * logout routes pair it with browserSessionStore.delete(): the store entry
 * and the cookie go away together (RP-Initiated Logout 1.0 §2).
 */
export function buildClearedSessionCookie(): string {
  return SESSION_COOKIE_NAME + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}
`
    : '';
  return `import type {
  AuthTransaction,
  AuthTransactionStore,
  AuthorizationCodeInfo,
  AccessTokenInfo,
  RefreshTokenInfo,
  UserClaims,
} from '${corePkg}';${parStoreTypeImport}${deviceStoreTypeImport}${cibaStoreTypeImport}${googleLoginStoreTypeImport}

/**
 * In-memory Authorization Transaction Store.
 * In production, replace with a persistent store (e.g., Redis, database).
 */
export class InMemoryTransactionStore implements AuthTransactionStore {
  private store = new Map<string, { value: AuthTransaction; expiresAt: number }>();

  async get(key: string): Promise<AuthTransaction | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: AuthTransaction, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + (ttlSeconds * 1000) });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/**
 * In-memory Authorization Code Store.
 * Stores issued authorization codes and their associated data.
 */
export class AuthorizationCodeStore {
  private codes = new Map<string, AuthorizationCodeInfo>();

  set(code: string, info: AuthorizationCodeInfo): void {
    this.codes.set(code, info);
  }

  get(code: string): AuthorizationCodeInfo | undefined {
    const entry = this.codes.get(code);
    if (!entry) return undefined;
    const now = Math.floor(Date.now() / 1000);
    if (entry.expiresAt <= now) {
      this.codes.delete(code);
      return undefined;
    }
    return entry;
  }

  // Mark the authorization code as used (do NOT physically delete it).
  // OAuth 2.1 §4.1.2 / RFC 9700 §4.13: a replayed code must still be findable as
  // used:true so revokeAuthorizationCode can detect reuse and revoke the grant's
  // tokens. The resolver path uses consume(); see delete() for physical removal.
  consume(code: string): void {
    const entry = this.codes.get(code);
    if (entry) {
      entry.used = true;
    }
  }

  // Physically remove the entry. Use only where physical deletion is correct
  // (e.g. expired-entry eviction), never as the resolver's "code used" path —
  // that must be consume() so reuse detection keeps working.
  delete(code: string): void {
    this.codes.delete(code);
  }
}

/**
 * In-memory Access Token Store.
 * Stores issued access tokens for UserInfo endpoint validation.
 */
export class AccessTokenStore {
  private tokens = new Map<string, AccessTokenInfo>();

  set(token: string, info: AccessTokenInfo): void {
    this.tokens.set(token, info);
  }

  get(token: string): AccessTokenInfo | undefined {
    const entry = this.tokens.get(token);
    if (!entry) return undefined;
    // Lazy eviction (RFC 6819 §5.1.5.3 / RFC 9700 §4.14): drop expired entries on
    // read so an idle in-memory store does not grow unbounded. Correctness is already
    // guaranteed by the core expiry check; this only bounds retention.
    const now = Math.floor(Date.now() / 1000);
    if (entry.expiresAt <= now) {
      this.tokens.delete(token);
      return undefined;
    }
    return entry;
  }

  delete(token: string): void {
    this.tokens.delete(token);
  }

  // OAuth 2.1 Section 4.1.2: revoke all access tokens issued under a given grant
  // when the originating authorization code is reused.
  revokeByGrantId(grantId: string): void {
    for (const [token, info] of this.tokens) {
      if (info.grantId === grantId) {
        this.tokens.delete(token);
      }
    }
  }

  /** Revoke a single access token. Used by RFC 7009 revocation endpoint. */
  revoke(token: string): void {
    this.tokens.delete(token);
  }
}

/**
 * In-memory Refresh Token Store.
 * Stores issued refresh tokens for token rotation.
 * OAuth 2.1 Section 4.3
 */
export class RefreshTokenStore {
  private tokens = new Map<string, RefreshTokenInfo>();

  set(token: string, info: RefreshTokenInfo): void {
    this.tokens.set(token, info);
  }

  get(token: string): RefreshTokenInfo | undefined {
    const entry = this.tokens.get(token);
    if (!entry) return undefined;
    // Lazy eviction only past the absolute lifetime (expiresAt). A used=true but
    // still-in-lifetime entry MUST remain so rotation-reuse detection (revokeByGrantId)
    // keeps firing (OAuth 2.1 4.3.1 / RFC 9700 4.13). Eviction never keys on the used flag.
    const now = Math.floor(Date.now() / 1000);
    if (entry.expiresAt <= now) {
      this.tokens.delete(token);
      return undefined;
    }
    return entry;
  }

  // Mark the rotated refresh token as used (do NOT physically delete it).
  // OAuth 2.1 §4.3.1 / RFC 9700 §4.13: a replayed (already-rotated) refresh token
  // must remain findable as used:true so reuse detection can revoke the grant.
  // The resolver path uses consume(); see delete() for physical removal.
  consume(token: string): void {
    const entry = this.tokens.get(token);
    if (entry) {
      entry.used = true;
    }
  }

  // Physically remove the entry. Use only where physical deletion is correct
  // (e.g. revocation / grant cascade / expired-entry eviction), never as the
  // resolver's "rotated" path — that must be consume() to keep reuse detection.
  delete(token: string): void {
    this.tokens.delete(token);
  }

  // OAuth 2.1 Section 4.1.2: revoke all refresh tokens (including rotated ones)
  // sharing the given grantId when the originating authorization code is reused.
  revokeByGrantId(grantId: string): void {
    for (const [token, info] of this.tokens) {
      if (info.grantId === grantId) {
        this.tokens.delete(token);
      }
    }
  }

  /** Revoke a single refresh token. Used by RFC 7009 revocation endpoint. */
  revoke(token: string): void {
    this.tokens.delete(token);
  }
}

/**
 * In-memory authenticated session store.
 * Keeps login results between login and consent steps.
 */
export interface AuthSessionInfo {
  subject: string;
  authTime: number;
  /**
   * このログインで確立（または再利用）したブラウザセッションの識別子。
   * consent 画面を経て発行する認可コードへ引き継ぎ、online refresh token を
   * そのセッションへ束縛するために使う。
   */
  sessionId?: string;
}

export class AuthSessionStore {
  private sessions = new Map<string, AuthSessionInfo>();

  set(transactionId: string, info: AuthSessionInfo): void {
    this.sessions.set(transactionId, info);
  }

  get(transactionId: string): AuthSessionInfo | undefined {
    return this.sessions.get(transactionId);
  }

  delete(transactionId: string): void {
    this.sessions.delete(transactionId);
  }
}

/**
 * Browser (OP) session store - OIDC Core 1.0 Section 3.1.2.3.
 * Unlike AuthSessionStore (a per-transaction login -> consent handoff), this
 * persists across authorization requests, keyed by an opaque session_id carried
 * in an HttpOnly cookie. It is what makes SSO, prompt=none and max_age work.
 * In production, replace with a persistent store (e.g., KV, database).
 */
export const SESSION_COOKIE_NAME = 'session_id';

export interface BrowserSessionInfo {
  subject: string;
  authTime: number;
}

export class BrowserSessionStore {
  private sessions = new Map<string, BrowserSessionInfo>();

  set(sessionId: string, info: BrowserSessionInfo): void {
    this.sessions.set(sessionId, info);
  }

  get(sessionId: string): BrowserSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/**
 * Extract the session_id value from a Cookie request header.
 * Returns undefined when the header is missing or the cookie is absent.
 */
export function parseSessionId(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === SESSION_COOKIE_NAME) {
      return trimmed.slice(eq + 1);
    }
  }
  return undefined;
}

/**
 * Build the Set-Cookie value for the browser session.
 * Security attributes: HttpOnly (no JS access), Secure (HTTPS only),
 * SameSite=Lax. SameSite=Strict
 * would drop the cookie on the cross-site authorization redirect return and
 * break the flow, so Lax is required.
 */
export function buildSessionCookie(sessionId: string): string {
  return SESSION_COOKIE_NAME + '=' + sessionId + '; HttpOnly; Secure; SameSite=Lax; Path=/';
}

/**
 * Auth transaction cookie - which authorization request this browser is in the
 * middle of (OIDC Core 1.0 Section 3.1.2.3 / 3.1.2.4).
 *
 * /authorize hands the transaction id to the browser in this HttpOnly cookie
 * and nowhere else: the /login and /consent URLs carry no query, and their
 * forms embed only csrf_token. Every login / consent step reads the transaction
 * out of this cookie and accepts a submission only when the posted csrf_token
 * belongs to that transaction, so the cookie and the HTML have to come
 * together.
 *
 * Why not the URL: an id in the URL leaks through browser history, access logs
 * or a shared screen. Whoever picks it up could open the consent page, read
 * csrf_token off it and finish the flow; worse, an attacker could start a flow
 * with their OWN client and lure the victim to it, so that the victim's
 * authorization code is delivered to the attacker's client - a case the RP's
 * state check cannot catch. Neither works when the id only ever lives in a
 * cookie that page scripts cannot read and other sites cannot set.
 *
 * One cookie per browser: a second /authorize (another tab) replaces it, and a
 * form still open in the first tab is then refused - its csrf_token belongs to
 * the replaced transaction - instead of completing the wrong request.
 *
 * The '__Host-' prefix makes the browser refuse this cookie unless it comes
 * from this exact host with Secure, Path=/ and no Domain. Without it a sibling
 * subdomain (evil.example.com next to op.example.com) could plant its own
 * transaction in the victim's browser ("cookie tossing") - and the csrf_token
 * of that planted transaction is one the attacker already knows. Browsers
 * accept the prefix on http://localhost as well, so local development works.
 */
export const TRANSACTION_COOKIE_NAME = '__Host-oidc_txn';

/**
 * Build the Set-Cookie value that hands a transaction to this browser.
 * Same attributes as the session cookie: HttpOnly (no JS access), Secure
 * (HTTPS only; http://localhost is treated as trustworthy by browsers) and
 * SameSite=Lax, because SameSite=Strict would drop the cookie on the
 * cross-site navigation that starts the flow. Secure and Path=/ (and no
 * Domain) are also what the '__Host-' prefix requires. Max-Age matches the
 * transaction TTL so an abandoned flow does not leave the cookie behind.
 */
export function buildTransactionCookie(transactionId: string, ttlSeconds: number): string {
  return (
    TRANSACTION_COOKIE_NAME + '=' + transactionId +
    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + String(ttlSeconds)
  );
}

/**
 * Build the Set-Cookie value that removes the transaction cookie once the
 * transaction is finished (code issued or access denied). It repeats Secure
 * and Path=/: the browser ignores a '__Host-' cookie write without them, the
 * removal included.
 */
export function buildClearedTransactionCookie(): string {
  return TRANSACTION_COOKIE_NAME + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

/**
 * Extract the transaction id from a Cookie request header.
 * Returns undefined when the header is missing or the cookie is absent.
 */
export function parseTransactionId(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === TRANSACTION_COOKIE_NAME) {
      return trimmed.slice(eq + 1) || undefined;
    }
  }
  return undefined;
}

/**
 * Whether a form POST to /login or /consent was sent from the OP's own pages.
 *
 * A check that depends on neither the transaction cookie nor the csrf_token:
 * the browser itself states where the request came from, and no page script
 * can override these headers. It still holds when a sibling subdomain managed
 * to plant a transaction cookie and therefore knows its csrf_token, and it is
 * the only check SameSite=Lax leaves to a same-site (sibling subdomain) POST.
 *
 * - Sec-Fetch-Site (Fetch Metadata): only 'same-origin' passes, plus 'none' -
 *   a user-initiated request such as a reload, which no other site can
 *   trigger. 'same-site' (a sibling subdomain) and 'cross-site' do not.
 * - Without Fetch Metadata, the Origin header a browser sends on every POST
 *   must be the issuer's origin. 'null' (an opaque origin) never matches.
 * - With neither header the request did not come from a browser page (curl, an
 *   HTTP client) or from a very old browser; the transaction cookie and the
 *   csrf_token still apply.
 *
 * The comparison uses config.issuer, never the request URL: some runtimes
 * derive the request URL from the Host header, which the sender controls.
 */
export function isSameOriginFormPost(
  headers: { origin: string | null; secFetchSite: string | null },
  issuer: string,
): boolean {
  if (headers.secFetchSite !== null) {
    return headers.secFetchSite === 'same-origin' || headers.secFetchSite === 'none';
  }
  if (headers.origin !== null) {
    return headers.origin === new URL(issuer).origin;
  }
  return true;
}

/** The message the OP shows when isSameOriginFormPost() refuses a form POST. */
export const CROSS_ORIGIN_FORM_POST_MESSAGE =
  'This form can only be submitted from the authorization server itself.';
${rpInitiatedLogoutHelpers}
/**
 * In-memory consent store. Records that a user granted a set of scopes to a
 * client so prompt=none can confirm consent without showing UI
 * (OIDC Core 1.0 Section 3.1.2.1).
 */
export class ConsentStore {
  private grants = new Map<string, Map<string, Set<string>>>();
  // One consent can authorize multiple code flows. Keep every resulting grantId
  // indexed by subject + client so a user-initiated "remove access" operation
  // can revoke the complete AT/RT families without touching another client.
  private grantIds = new Map<string, Map<string, Set<string>>>();

  grant(subject: string, clientId: string, scopes: string[]): void {
    let byClient = this.grants.get(subject);
    if (!byClient) {
      byClient = new Map<string, Set<string>>();
      this.grants.set(subject, byClient);
    }
    const granted = byClient.get(clientId) ?? new Set<string>();
    for (const s of scopes) granted.add(s);
    byClient.set(clientId, granted);
  }

  hasConsent(subject: string, clientId: string, scopes: string[]): boolean {
    const granted = this.grants.get(subject)?.get(clientId);
    if (!granted) return false;
    return scopes.every((s) => granted.has(s));
  }

  recordGrant(subject: string, clientId: string, grantId: string): void {
    let byClient = this.grantIds.get(subject);
    if (!byClient) {
      byClient = new Map<string, Set<string>>();
      this.grantIds.set(subject, byClient);
    }
    const ids = byClient.get(clientId) ?? new Set<string>();
    ids.add(grantId);
    byClient.set(clientId, ids);
  }

  // Revoke all consent the subject granted to a client (e.g. "remove access")
  // and atomically detach the grant ids that the caller must cascade-revoke.
  revoke(subject: string, clientId: string): string[] {
    const ids = [...(this.grantIds.get(subject)?.get(clientId) ?? [])];
    this.grants.get(subject)?.delete(clientId);
    this.grantIds.get(subject)?.delete(clientId);
    return ids;
  }
}

/**
 * In-memory User Store.
 * Stores user profiles for authentication and UserInfo responses.
 * In production, replace with a database-backed user store.
 */
export class UserStore {
  private users = new Map<string, UserClaims & { password: string }>();

${googleUsersField}  constructor() {
    // Example user for development.
    // Carries the standard claims for every scope advertised in Discovery
    // (profile / email / address / phone — OIDC Core 1.0 §5.4) so the OIDF
    // Conformance Suite's VerifyScopesReturnedInUserInfoClaims finds a value for
    // each requested scope. filterClaimsByScope still gates what is returned per
    // scope; populating the fixture is the resolver's responsibility.
    this.users.set('testuser', {
      sub: 'testuser',
      // profile scope
      name: 'Test User',
      family_name: 'User',
      given_name: 'Test',
      middle_name: 'Q',
      nickname: 'testy',
      preferred_username: 'testuser',
      profile: 'https://op.example.com/users/testuser',
      picture: 'https://op.example.com/users/testuser/avatar.png',
      website: 'https://testuser.example.com',
      gender: 'unspecified',
      birthdate: '1990-01-01',
      zoneinfo: 'Asia/Tokyo',
      locale: 'en-US',
      updated_at: 1700000000,
      // email scope
      email: 'test@example.com',
      email_verified: true,
      // address scope
      address: {
        formatted: '100 Test Street, Test City, TS 10000, JP',
        street_address: '100 Test Street',
        locality: 'Test City',
        region: 'TS',
        postal_code: '10000',
        country: 'JP',
      },
      // phone scope
      phone_number: '+81-3-0000-0000',
      phone_number_verified: true,
      password: 'password',
    });

    // A second fixture makes subject-isolation and id_token_hint/session mismatch
    // flows reproducible with real signed tokens. It is development-only example
    // data, not a multi-account policy for production integrations.
    this.users.set('otheruser', {
      sub: 'otheruser',
      name: 'Other User',
      preferred_username: 'otheruser',
      email: 'other@example.com',
      email_verified: true,
      password: 'password',
    });
  }

  authenticate(username: string, password: string): (UserClaims & { password: string }) | undefined {
    const user = this.users.get(username);
    if (user && user.password === password) {
      return user;
    }
    return undefined;
  }

  getClaims(sub: string): UserClaims | undefined {
    const user = this.users.get(sub);
    if (!user) return ${userStoreGoogleFallback};
    const { password: _, ...claims } = user;
    return claims;
  }
${userStoreGoogleMethods}}

${googleLoginStoreImplementation}export type Awaitable<T> = T | Promise<T>;

export interface JsonStoreEntry<T> {
  key: string;
  value: T;
}

/**
 * Minimal JSON key/value contract used by generated persistent stores.
 * Implement it with D1, SQLite, Redis, KV, or another deployment-native store.
 * list() must return only live entries whose keys start with prefix.
 */
export interface JsonStoreBackend {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(prefix: string): Promise<Array<JsonStoreEntry<T>>>;
}

export interface AuthorizationCodeStorage {
  set(code: string, info: AuthorizationCodeInfo): Awaitable<void>;
  get(code: string): Awaitable<AuthorizationCodeInfo | undefined>;
  consume(code: string): Awaitable<void>;
  delete(code: string): Awaitable<void>;
}

export interface AccessTokenStorage {
  set(token: string, info: AccessTokenInfo): Awaitable<void>;
  get(token: string): Awaitable<AccessTokenInfo | undefined>;
  delete(token: string): Awaitable<void>;
  revokeByGrantId(grantId: string): Awaitable<void>;
  revoke(token: string): Awaitable<void>;
}

export interface RefreshTokenStorage {
  set(token: string, info: RefreshTokenInfo): Awaitable<void>;
  get(token: string): Awaitable<RefreshTokenInfo | undefined>;
  consume(token: string): Awaitable<void>;
  delete(token: string): Awaitable<void>;
  revokeByGrantId(grantId: string): Awaitable<void>;
  revoke(token: string): Awaitable<void>;
}

export interface AuthSessionStorage {
  set(transactionId: string, info: AuthSessionInfo): Awaitable<void>;
  get(transactionId: string): Awaitable<AuthSessionInfo | undefined>;
  delete(transactionId: string): Awaitable<void>;
}

export interface BrowserSessionStorage {
  set(sessionId: string, info: BrowserSessionInfo): Awaitable<void>;
  get(sessionId: string): Awaitable<BrowserSessionInfo | undefined>;
  delete(sessionId: string): Awaitable<void>;
}

export interface ConsentStorage {
  grant(subject: string, clientId: string, scopes: string[]): Awaitable<void>;
  hasConsent(subject: string, clientId: string, scopes: string[]): Awaitable<boolean>;
  recordGrant(subject: string, clientId: string, grantId: string): Awaitable<void>;
  revoke(subject: string, clientId: string): Awaitable<string[]>;
}

export interface UserStorage {
  authenticate(
    username: string,
    password: string,
  ): Awaitable<(UserClaims & { password: string }) | undefined>;
  getClaims(sub: string): Awaitable<UserClaims | undefined>;
${userStorageGoogleMember}}

export interface ProviderStores {
  transactionStore: AuthTransactionStore;
  authCodeStore: AuthorizationCodeStorage;
  accessTokenStore: AccessTokenStorage;
  refreshTokenStore: RefreshTokenStorage;
  authSessionStore: AuthSessionStorage;
  browserSessionStore: BrowserSessionStorage;
  consentStore: ConsentStorage;
  userStore: UserStorage;
${providerStoresGoogleMember}}

export type ProviderStoresFactory = (
  context: any,
) => Awaitable<ProviderStores>;

const TRANSACTION_PREFIX = 'transaction:';
const AUTHORIZATION_CODE_PREFIX = 'authorization-code:';
const ACCESS_TOKEN_PREFIX = 'access-token:';
const REFRESH_TOKEN_PREFIX = 'refresh-token:';
const AUTH_SESSION_PREFIX = 'auth-session:';
const BROWSER_SESSION_PREFIX = 'browser-session:';
const CONSENT_PREFIX = 'consent:';
const USER_PREFIX = 'user:';${googleLoginPrefixes}

class JsonTransactionStore implements AuthTransactionStore {
  constructor(private readonly backend: JsonStoreBackend) {}

  async get(key: string): Promise<AuthTransaction | null> {
    return this.backend.get<AuthTransaction>(TRANSACTION_PREFIX + key);
  }

  async put(key: string, value: AuthTransaction, ttlSeconds: number): Promise<void> {
    await this.backend.put(TRANSACTION_PREFIX + key, value, ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.backend.delete(TRANSACTION_PREFIX + key);
  }
}

class JsonAuthorizationCodeStore implements AuthorizationCodeStorage {
  constructor(private readonly backend: JsonStoreBackend) {}

  async set(code: string, info: AuthorizationCodeInfo): Promise<void> {
    await this.backend.put(
      AUTHORIZATION_CODE_PREFIX + code,
      info,
      ttlUntil(info.expiresAt),
    );
  }

  async get(code: string): Promise<AuthorizationCodeInfo | undefined> {
    const entry = await this.backend.get<AuthorizationCodeInfo>(AUTHORIZATION_CODE_PREFIX + code);
    if (!entry) return undefined;
    if (entry.expiresAt <= epochSeconds()) {
      await this.delete(code);
      return undefined;
    }
    return entry;
  }

  async consume(code: string): Promise<void> {
    const entry = await this.get(code);
    if (!entry) return;
    await this.set(code, { ...entry, used: true });
  }

  async delete(code: string): Promise<void> {
    await this.backend.delete(AUTHORIZATION_CODE_PREFIX + code);
  }
}

class JsonAccessTokenStore implements AccessTokenStorage {
  constructor(private readonly backend: JsonStoreBackend) {}

  async set(token: string, info: AccessTokenInfo): Promise<void> {
    await this.backend.put(ACCESS_TOKEN_PREFIX + token, info, ttlUntil(info.expiresAt));
  }

  async get(token: string): Promise<AccessTokenInfo | undefined> {
    const entry = await this.backend.get<AccessTokenInfo>(ACCESS_TOKEN_PREFIX + token);
    if (!entry) return undefined;
    if (entry.expiresAt <= epochSeconds()) {
      await this.delete(token);
      return undefined;
    }
    return entry;
  }

  async delete(token: string): Promise<void> {
    await this.backend.delete(ACCESS_TOKEN_PREFIX + token);
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    const entries = await this.backend.list<AccessTokenInfo>(ACCESS_TOKEN_PREFIX);
    await Promise.all(
      entries
        .filter((entry) => entry.value.grantId === grantId)
        .map((entry) => this.backend.delete(entry.key)),
    );
  }

  async revoke(token: string): Promise<void> {
    await this.delete(token);
  }
}

class JsonRefreshTokenStore implements RefreshTokenStorage {
  constructor(private readonly backend: JsonStoreBackend) {}

  async set(token: string, info: RefreshTokenInfo): Promise<void> {
    await this.backend.put(REFRESH_TOKEN_PREFIX + token, info, ttlUntil(info.expiresAt));
  }

  async get(token: string): Promise<RefreshTokenInfo | undefined> {
    const entry = await this.backend.get<RefreshTokenInfo>(REFRESH_TOKEN_PREFIX + token);
    if (!entry) return undefined;
    if (entry.expiresAt <= epochSeconds()) {
      await this.delete(token);
      return undefined;
    }
    return entry;
  }

  async consume(token: string): Promise<void> {
    const entry = await this.get(token);
    if (!entry) return;
    await this.set(token, { ...entry, used: true });
  }

  async delete(token: string): Promise<void> {
    await this.backend.delete(REFRESH_TOKEN_PREFIX + token);
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    const entries = await this.backend.list<RefreshTokenInfo>(REFRESH_TOKEN_PREFIX);
    await Promise.all(
      entries
        .filter((entry) => entry.value.grantId === grantId)
        .map((entry) => this.backend.delete(entry.key)),
    );
  }

  async revoke(token: string): Promise<void> {
    await this.delete(token);
  }
}

class JsonAuthSessionStore implements AuthSessionStorage {
  constructor(private readonly backend: JsonStoreBackend) {}

  async set(transactionId: string, info: AuthSessionInfo): Promise<void> {
    await this.backend.put(AUTH_SESSION_PREFIX + transactionId, info);
  }

  async get(transactionId: string): Promise<AuthSessionInfo | undefined> {
    return (await this.backend.get<AuthSessionInfo>(AUTH_SESSION_PREFIX + transactionId)) ?? undefined;
  }

  async delete(transactionId: string): Promise<void> {
    await this.backend.delete(AUTH_SESSION_PREFIX + transactionId);
  }
}

class JsonBrowserSessionStore implements BrowserSessionStorage {
  constructor(private readonly backend: JsonStoreBackend) {}

  async set(sessionId: string, info: BrowserSessionInfo): Promise<void> {
    await this.backend.put(BROWSER_SESSION_PREFIX + sessionId, info);
  }

  async get(sessionId: string): Promise<BrowserSessionInfo | undefined> {
    return (await this.backend.get<BrowserSessionInfo>(BROWSER_SESSION_PREFIX + sessionId)) ?? undefined;
  }

  async delete(sessionId: string): Promise<void> {
    await this.backend.delete(BROWSER_SESSION_PREFIX + sessionId);
  }
}

interface StoredConsent {
  scopes: string[];
  grantIds: string[];
}

class JsonConsentStore implements ConsentStorage {
  constructor(private readonly backend: JsonStoreBackend) {}

  async grant(subject: string, clientId: string, scopes: string[]): Promise<void> {
    const key = consentKey(subject, clientId);
    const current = await this.read(key);
    await this.backend.put(key, {
      scopes: [...new Set([...current.scopes, ...scopes])],
      grantIds: current.grantIds,
    });
  }

  async hasConsent(subject: string, clientId: string, scopes: string[]): Promise<boolean> {
    const current = await this.read(consentKey(subject, clientId));
    return scopes.every((scope) => current.scopes.includes(scope));
  }

  async recordGrant(subject: string, clientId: string, grantId: string): Promise<void> {
    const key = consentKey(subject, clientId);
    const current = await this.read(key);
    await this.backend.put(key, {
      scopes: current.scopes,
      grantIds: [...new Set([...current.grantIds, grantId])],
    });
  }

  async revoke(subject: string, clientId: string): Promise<string[]> {
    const key = consentKey(subject, clientId);
    const current = await this.read(key);
    await this.backend.delete(key);
    return current.grantIds;
  }

  private async read(key: string): Promise<StoredConsent> {
    return (await this.backend.get<StoredConsent>(key)) ?? { scopes: [], grantIds: [] };
  }
}

type StoredUser = UserClaims & { password: string };

class JsonUserStore implements UserStorage {
  constructor(private readonly backend: JsonStoreBackend) {}

  async authenticate(username: string, password: string): Promise<StoredUser | undefined> {
    const user = await this.findOrSeed(username);
    return user?.password === password ? user : undefined;
  }

  async getClaims(sub: string): Promise<UserClaims | undefined> {
    const user = await this.findOrSeed(sub);
    if (!user) return ${jsonUserStoreGoogleFallback};
    const { password: _, ...claims } = user;
    return claims;
  }

  private async findOrSeed(username: string): Promise<StoredUser | undefined> {
    const key = USER_PREFIX + username;
    const stored = await this.backend.get<StoredUser>(key);
    if (stored) return stored;
    const fixture = defaultUserFixture(username);
    if (!fixture) return undefined;
    await this.backend.put(key, fixture);
    return fixture;
  }
${jsonUserStoreGoogleMethods}}

${jsonGoogleNonceStore}/** Create all OP stores over one deployment-native JSON backend. */
export function createJsonProviderStores(backend: JsonStoreBackend): ProviderStores {
  return {
    transactionStore: new JsonTransactionStore(backend),
    authCodeStore: new JsonAuthorizationCodeStore(backend),
    accessTokenStore: new JsonAccessTokenStore(backend),
    refreshTokenStore: new JsonRefreshTokenStore(backend),
    authSessionStore: new JsonAuthSessionStore(backend),
    browserSessionStore: new JsonBrowserSessionStore(backend),
    consentStore: new JsonConsentStore(backend),
    userStore: new JsonUserStore(backend),
${jsonStoresGoogleEntry}  };
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function ttlUntil(expiresAt: number): number {
  return Math.max(1, expiresAt - epochSeconds());
}

function consentKey(subject: string, clientId: string): string {
  return CONSENT_PREFIX + encodeURIComponent(subject) + ':' + encodeURIComponent(clientId);
}

function defaultUserFixture(username: string): StoredUser | undefined {
  if (username === 'testuser') {
    return {
      sub: 'testuser',
      name: 'Test User',
      family_name: 'User',
      given_name: 'Test',
      middle_name: 'Q',
      nickname: 'testy',
      preferred_username: 'testuser',
      profile: 'https://op.example.com/users/testuser',
      picture: 'https://op.example.com/users/testuser/avatar.png',
      website: 'https://testuser.example.com',
      gender: 'unspecified',
      birthdate: '1990-01-01',
      zoneinfo: 'Asia/Tokyo',
      locale: 'en-US',
      updated_at: 1700000000,
      email: 'test@example.com',
      email_verified: true,
      address: {
        formatted: '100 Test Street, Test City, TS 10000, JP',
        street_address: '100 Test Street',
        locality: 'Test City',
        region: 'TS',
        postal_code: '10000',
        country: 'JP',
      },
      phone_number: '+81-3-0000-0000',
      phone_number_verified: true,
      password: 'password',
    };
  }
  if (username === 'otheruser') {
    return {
      sub: 'otheruser',
      name: 'Other User',
      preferred_username: 'otheruser',
      email: 'other@example.com',
      email_verified: true,
      password: 'password',
    };
  }
  return undefined;
}

// Singleton store instances.
//
// Backed by globalThis so a single instance is shared process-wide. This is
// required on Next.js, where Server Components / Server Actions and Route
// Handlers are instantiated in separate module layers: a plain
// \`new Store()\` module export would produce a different instance per layer, so
// state written by the login/consent pages (transactions, sessions, consent)
// would be invisible to the /authorize and /token route handlers and vice
// versa. It also survives dev-mode hot reloads. Harmless for single-layer
// runtimes (Node / Hono / Express / Fastify), which always see one instance.
const storeRegistry = globalThis as typeof globalThis & {
  __oidcProviderStores?: ProviderStores;
};

export const defaultProviderStores = (storeRegistry.__oidcProviderStores ??= {
  transactionStore: new InMemoryTransactionStore(),
  authCodeStore: new AuthorizationCodeStore(),
  accessTokenStore: new AccessTokenStore(),
  refreshTokenStore: new RefreshTokenStore(),
  authSessionStore: new AuthSessionStore(),
  browserSessionStore: new BrowserSessionStore(),
  consentStore: new ConsentStore(),
  userStore: new UserStore(),
${defaultStoresGoogleEntry}});

export const transactionStore = defaultProviderStores.transactionStore;
export const authCodeStore = defaultProviderStores.authCodeStore;
export const accessTokenStore = defaultProviderStores.accessTokenStore;
export const refreshTokenStore = defaultProviderStores.refreshTokenStore;
export const authSessionStore = defaultProviderStores.authSessionStore;
export const browserSessionStore = defaultProviderStores.browserSessionStore;
export const consentStore = defaultProviderStores.consentStore;
export const userStore = defaultProviderStores.userStore;${googleLoginStoreExport}
${parStoreImplementation}${deviceStoreImplementation}${cibaStoreImplementation}`;
}

export function resolversTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  /** Where a project wires its own client resolver (framework-specific). */
  clientResolverInjectionNote = 'Project integrations should inject a D1/KV/env-backed resolver through Hono context.',
): string {
  const refreshTypeImports = features.refreshToken
    ? `  RefreshTokenResolver,
  RefreshTokenInfo,
  AuthenticationSessionResolver,
  AuthenticationSessionInfo,
`
    : '';
  const introspectionTypeImports = features.introspection
    ? `  IntrospectionAccessTokenResolver,
  IntrospectionRefreshTokenResolver,
`
    : '';
  const revocationTypeImports = features.revocation
    ? `  RevocationTokenResolvers,
`
    : '';
  const refreshTokenResolverBlock = features.refreshToken
    ? `  const refreshTokenResolver: RefreshTokenResolver = {
    async resolve(token: string): Promise<RefreshTokenInfo | null> {
      return (await refreshTokenStore.get(token)) ?? null;
    },
    async revokeRefreshToken(token: string): Promise<void> {
      await refreshTokenStore.consume(token);
    },
    async revokeTokensByGrantId(grantId: string): Promise<void> {
      await accessTokenStore.revokeByGrantId(grantId);
      await refreshTokenStore.revokeByGrantId(grantId);
    },
  };

`
    : '';
  const refreshReturnField = features.refreshToken
    ? `    refreshTokenResolver,
    authenticationSessionResolver,
`
    : '';
  const refreshExport = features.refreshToken
    ? `export const refreshTokenResolver = defaultStoreResolvers.refreshTokenResolver;
export const authenticationSessionResolver =
  defaultStoreResolvers.authenticationSessionResolver;
`
    : '';
  // online refresh token の束縛先セッションを、トークンエンドポイントから sessionId で
  // 引くためのリゾルバー。refresh token 機能が無ければ不要なので同じトグルで出し分ける。
  const authenticationSessionResolverBlock = features.refreshToken
    ? `  // online refresh token の束縛先セッションを sessionId から引く。sessionResolver は
  // Cookie を持つブラウザリクエストから引く入口で、トークンエンドポイントには End-User の
  // Cookie が届かないため、保存された sessionId から直接引くこちらが要る。
  // 終了したセッションでは必ず null を返すこと。返し続けると online refresh token が
  // ログアウト後も使えてしまう。
  const authenticationSessionResolver: AuthenticationSessionResolver = {
    async findSession(sessionId: string): Promise<AuthenticationSessionInfo | null> {
      const session = await browserSessionStore.get(sessionId);
      if (!session) return null;
      return { subject: session.subject, authTime: session.authTime };
    },
  };

`
    : '';
  const introspectionResolversBlock = features.introspection
    ? `  const introspectionAccessTokenResolver: IntrospectionAccessTokenResolver = {
    async findAccessToken(token) {
      return (await accessTokenStore.get(token)) ?? null;
    },
  };

  const introspectionRefreshTokenResolver: IntrospectionRefreshTokenResolver = {
    async resolve(token) {
      return (await refreshTokenStore.get(token)) ?? null;
    },
  };

`
    : '';
  const introspectionReturnFields = features.introspection
    ? `    introspectionAccessTokenResolver,
    introspectionRefreshTokenResolver,
`
    : '';
  const introspectionExports = features.introspection
    ? `export const introspectionAccessTokenResolver =
  defaultStoreResolvers.introspectionAccessTokenResolver;
export const introspectionRefreshTokenResolver =
  defaultStoreResolvers.introspectionRefreshTokenResolver;
`
    : '';
  const revocationResolversBlock = features.revocation
    ? `  const revocationResolvers: RevocationTokenResolvers = {
    async findAccessToken(token) {
      return (await accessTokenStore.get(token)) ?? null;
    },
    async revokeAccessToken(token) {
      await accessTokenStore.revoke(token);
    },
    async findRefreshToken(token) {
      return (await refreshTokenStore.get(token)) ?? null;
    },
    async revokeRefreshToken(token) {
      await refreshTokenStore.revoke(token);
    },
    async revokeAccessTokensByGrantId(grantId) {
      await accessTokenStore.revokeByGrantId(grantId);
    },
  };

`
    : '';
  const revocationReturnField = features.revocation ? `    revocationResolvers,
` : '';
  const revocationExport = features.revocation
    ? `export const revocationResolvers = defaultStoreResolvers.revocationResolvers;
`
    : '';
  return `import type {
  ClientResolver,
  TokenClientResolver,
  AuthorizationCodeResolver,
  AuthorizationCodeInfo,
  AccessTokenResolver,
  AccessTokenInfo,
${refreshTypeImports}  UserClaimsResolver,
  UserClaims,
${introspectionTypeImports}${revocationTypeImports}  SessionResolver,
  SessionInfo,
  ConsentResolver,
} from '${corePkg}';
import { createInMemoryClientResolver } from './config.js';
import {
  defaultProviderStores,
  parseSessionId,
  type ProviderStores,
} from './store.js';

/**
 * Default in-memory client resolver for quick local testing.
 * ${clientResolverInjectionNote}
 */
export const clientResolver: ClientResolver & TokenClientResolver =
  createInMemoryClientResolver();

export const tokenClientResolver: TokenClientResolver = clientResolver;

/**
 * Build the resolver suite over one coherent store set. A request must never
 * mix resolvers from one backend with direct stores from another backend.
 */
export type GrantAwareConsentResolver = ConsentResolver & {
  recordGrant(subject: string, clientId: string, grantId: string): Promise<void>;
};

export function createStoreResolvers(stores: ProviderStores) {
  const {
    authCodeStore,
    accessTokenStore,
    refreshTokenStore,
    userStore,
    browserSessionStore,
    consentStore,
  } = stores;

  const authorizationCodeResolver: AuthorizationCodeResolver = {
    async findAuthorizationCode(code: string): Promise<AuthorizationCodeInfo | null> {
      return (await authCodeStore.get(code)) ?? null;
    },
    async revokeAuthorizationCode(code: string): Promise<void> {
      await authCodeStore.consume(code);
    },
    async revokeTokensByGrantId(grantId: string): Promise<void> {
      await accessTokenStore.revokeByGrantId(grantId);
      await refreshTokenStore.revokeByGrantId(grantId);
    },
  };

  const accessTokenResolver: AccessTokenResolver = {
    async findAccessToken(token: string): Promise<AccessTokenInfo | null> {
      return (await accessTokenStore.get(token)) ?? null;
    },
  };

${refreshTokenResolverBlock}  const userClaimsResolver: UserClaimsResolver = {
    async findUserClaims(sub: string): Promise<UserClaims | null> {
      return (await userStore.getClaims(sub)) ?? null;
    },
  };

${introspectionResolversBlock}${revocationResolversBlock}  const sessionResolver: SessionResolver = {
    async resolve(request: Request): Promise<SessionInfo | null> {
      const sessionId = parseSessionId(request.headers.get('Cookie'));
      if (!sessionId) return null;
      const session = await browserSessionStore.get(sessionId);
      if (!session) return null;
      // sessionId まで返すのは online refresh token のため。認可コードへ引き継ぎ、
      // トークンエンドポイントが Refresh Token をこのセッションへ束縛する。
      return { subject: session.subject, authTime: session.authTime, sessionId };
    },
  };

${authenticationSessionResolverBlock}  const revokeConsentAndTokens = async (subject: string, clientId: string): Promise<void> => {
    const grantIds = await consentStore.revoke(subject, clientId);
    for (const grantId of grantIds) {
      await authorizationCodeResolver.revokeTokensByGrantId?.(grantId);
    }
  };

  const consentResolver: GrantAwareConsentResolver = {
    async hasConsent(subject: string, clientId: string, scopes: string[]): Promise<boolean> {
      return consentStore.hasConsent(subject, clientId, scopes);
    },
    async recordConsent(subject: string, clientId: string, scopes: string[]): Promise<void> {
      await consentStore.grant(subject, clientId, scopes);
    },
    async recordGrant(subject: string, clientId: string, grantId: string): Promise<void> {
      await consentStore.recordGrant(subject, clientId, grantId);
    },
    async revokeConsent(subject: string, clientId: string): Promise<void> {
      await revokeConsentAndTokens(subject, clientId);
    },
  };

  return {
    authorizationCodeResolver,
    accessTokenResolver,
${refreshReturnField}    userClaimsResolver,
${introspectionReturnFields}${revocationReturnField}    sessionResolver,
    consentResolver,
    revokeConsentAndTokens,
  };
}

const defaultStoreResolvers = createStoreResolvers(defaultProviderStores);

export const authorizationCodeResolver = defaultStoreResolvers.authorizationCodeResolver;
export const accessTokenResolver = defaultStoreResolvers.accessTokenResolver;
${refreshExport}export const userClaimsResolver = defaultStoreResolvers.userClaimsResolver;
${introspectionExports}${revocationExport}export const sessionResolver = defaultStoreResolvers.sessionResolver;
export const consentResolver = defaultStoreResolvers.consentResolver;

export async function revokeConsentAndTokens(subject: string, clientId: string): Promise<void> {
  await defaultStoreResolvers.revokeConsentAndTokens(subject, clientId);
}
`;
}

export function authorizeRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
): string {
  // Custom scopes (--scope). With none declared every interpolation below is
  // empty and the route is byte-identical to before.
  const customScopesDeclared = scopes.length > 0;
  const customScopeImports = customScopesDeclared
    ? `
import { findUnsupportedScopes, resolveGrantableScopes } from '../scopes.js';`
    : '';
  // AuthorizationErrorCode is already imported by the jarm feature; importing it
  // twice would not compile.
  const customScopeCoreImports = customScopesDeclared && !features.jarm
    ? `
  AuthorizationErrorCode,`
    : '';
  const customScopeStep = customScopesDeclared
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
    }
`
    : '';
  // Both non-interactive paths below decide the grant without ever reaching
  // /consent, so each applies the scope policy (scopes.ts) for itself.
  const promptNoneUserScopeStep = customScopesDeclared
    ? `
        // Apply the scope policy BEFORE the consent lookup: searching consent for
        // a scope this End-User can never hold would answer consent_required
        // forever (OIDC Core 1.0 §3.1.2.1). See resolveGrantableScopes() in
        // scopes.ts — that function is where per-user filtering is written.
        transaction.scope = (await resolveGrantableScopes(
          transaction.scope.split(' ').filter(Boolean),
          session.subject,
        )).join(' ');
`
    : '';
  const ssoUserScopeStep = customScopesDeclared
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
  const requestObjectImports = features.requestObject
    ? `
  resolveRequestObjectParams,
  validateRequestObjectConsistency,`
    : '';
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
  // EXPERIMENTAL (RFC 9126): resolve a URN-form request_uri into the parameters
  // that were pushed to /par. Every interpolation below collapses to the current
  // output when the par feature is off, so the default generation is unchanged.
  const parImports = features.par
    ? `
import {
  PushedRequestUriError,
  assertPushedRequestUsed,
  resolvePushedRequestUri,
} from '${EXPERIMENTAL_PACKAGE}/par';
import { parConfig } from './par.js';
import { parStore as defaultParStore } from '../store.js';`
    : '';
  // The resolve step must run INSIDE the try block: PushedRequestUriError has to
  // reach the catch below, otherwise it escapes as an unhandled 500.
  const parParamsBinding = features.par
    ? `  let params = rawParams;`
    : `  const params = rawParams;`;
  const parResolveStep = features.par
    ? `    // EXPERIMENTAL — Pushed Authorization Requests (RFC 9126 §4).
    const parStore = c.get('parStore') ?? defaultParStore;
    // RFC 9126 §5: when require_pushed_authorization_requests is on, an
    // authorization request that did not go through /par is rejected outright.
    if (parConfig.requirePushedAuthorizationRequests) {
      assertPushedRequestUsed(rawParams);
    }
    // Expand a request_uri of the form urn:ietf:params:oauth:request_uri:<ref> into
    // the parameters pushed to /par. The reference is single use and short lived,
    // so a reload of this URL fails with invalid_request_uri by design.
    // Anything that is not a URN (absent, or an OIDC Core §6.2 URL) returns null
    // and is left to the normal pipeline, which rejects it with
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
  // EXPERIMENTAL (JARM): response_mode=query.jwt / jwt turns the authorization
  // response into a single signed JWT carried in the `response` query parameter.
  // Every interpolation below collapses to the current output when the jarm
  // feature is off, so the default generation is unchanged byte for byte.
  const jarmImports = features.jarm
    ? `
import {
  buildJarmRedirectUrl,
  createJarmResponseJwt,
  resolveJarmResponseMode,
} from '${EXPERIMENTAL_PACKAGE}/jarm';
import { jarmConfig } from './jarm.js';`
    : '';
  const jarmCoreImports = features.jarm
    ? `
  AuthorizationErrorCode,
  selectSigningKeyByAlg,
  type SigningKey,`
    : '';
  // Declared before the try block: AuthorizationError is thrown from steps that
  // run before the transaction exists, and the catch below (which decides how to
  // render a redirectable error) cannot see anything declared inside the try.
  const jarmResponseBinding = features.jarm
    ? `
  // EXPERIMENTAL — JARM §2.3. Set once redirect_uri is verified; undefined means
  // the plain query response. Every authorize-route response site below reads
  // this local, so none of them depends on the transaction store round-trip.
  let jarmResponse: JarmResponseContext | undefined;`
    : '';
  const jarmResolveStep = features.jarm
    ? `    // EXPERIMENTAL — JARM §2.3: interpret response_mode now that redirect_uri is
    // verified, so an unsupported JWT mode can be reported as a redirectable
    // error. Values outside the \`.jwt\` family stay ignored exactly as before.
    const jarmResolution = resolveJarmResponseMode(effectiveParams);
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
    if (jarmResolution.kind === 'jarm') {
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
      jarmResponse = {
        issuer,
        clientId: client.clientId,
        signingKey: selectSigningKeyByAlg(jarmSigningKeys, 'RS256'),
      };
    }

`
    : '';
  // buildErrorRedirect becomes async under JARM (signing is async), so its call
  // sites gain an await and the response-context argument.
  const jarmAwait = features.jarm ? 'await ' : '';
  const jarmErrorArg = features.jarm ? 'jarmResponse, ' : '';
  // JARM mode is recorded on the stored transaction so the consent route — which
  // only ever sees the transaction it read back from the store — can answer in
  // the same mode. The auth transaction store MUST persist unknown fields.
  const buildRedirectHelpers = features.jarm
    ? `/**
 * EXPERIMENTAL — JARM response context (JARM Section 2.1).
 *
 * Present only for a request that asked for response_mode=query.jwt (or its
 * \`jwt\` shorthand). undefined means the plain query response this OP has always
 * produced, so a client that does not ask for JARM sees no change at all.
 */
type JarmResponseContext = {
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
}`;
  const promptNoneSuccessRedirect = features.jarm
    ? `      return {
      kind: 'authorization_response',
      location: await buildSuccessRedirect(
          jarmResponse,
          transaction.redirectUri,
          authCodeData.code,
          transaction.state,
          issuer,
        ),
      };`
    : `      const redirectUrl = new URL(transaction.redirectUri);
      redirectUrl.searchParams.set('code', authCodeData.code);
      if (transaction.state) redirectUrl.searchParams.set('state', transaction.state);
      // RFC 9207 §2: include iss in success responses too.
      redirectUrl.searchParams.set('iss', issuer);
      return { kind: 'authorization_response', location: redirectUrl.toString() };`;
  const ssoSuccessRedirect = features.jarm
    ? `            return {
            kind: 'authorization_response',
            location: await buildSuccessRedirect(
                jarmResponse,
                transaction.redirectUri,
                authCodeData.code,
                transaction.state,
                issuer,
              ),
            };`
    : `            const redirectUrl = new URL(transaction.redirectUri);
            redirectUrl.searchParams.set('code', authCodeData.code);
            if (transaction.state) redirectUrl.searchParams.set('state', transaction.state);
            // RFC 9207 §2: include iss in success responses.
            redirectUrl.searchParams.set('iss', issuer);
            return { kind: 'authorization_response', location: redirectUrl.toString() };`;
  const catchErrorRedirect = features.jarm
    ? `      if (error.redirectUri) {
        // RFC 9207 §2: include iss on error redirects so the client can
        // pin the issuer. config has already been read into context by
        // middleware; reread it here because the early-bound issuer is
        // scoped to the try block. EXPERIMENTAL (JARM §2.1): when this request
        // asked for a JWT response mode, the same members become claims of a
        // signed JWT and no plain parameter is added. jarmResponse is undefined
        // for errors thrown before response_mode was interpreted (unknown
        // client, unsupported JWT mode), which is why those stay plain.
        return {
        kind: 'authorization_response',
        location: await buildErrorRedirect(
            jarmResponse,
            error.redirectUri,
            error.error,
            error.state,
            error.errorDescription,
            c.get('config').issuer,
          ),
        };
      }`
    : `      if (error.redirectUri) {
        const redirectUrl = new URL(error.redirectUri);
        redirectUrl.searchParams.set('error', error.error);
        if (error.errorDescription) {
          redirectUrl.searchParams.set('error_description', error.errorDescription);
        }
        if (error.state) {
          redirectUrl.searchParams.set('state', error.state);
        }
        // RFC 9207 §2: include iss on error redirects so the client can
        // pin the issuer. config has already been read into context by
        // middleware; reread it here because the early-bound issuer is
        // scoped to the try block.
        redirectUrl.searchParams.set('iss', c.get('config').issuer);
        return { kind: 'authorization_response', location: redirectUrl.toString() };
      }`;
  const jarmTransactionPutArg = features.jarm
    ? `jarmResponse ? { ...transaction, jarmResponseMode: 'query.jwt' } : transaction,`
    : `transaction,`;
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
    : `    // The refresh_token feature is disabled in this generated provider:
    // the callback always returns false, so offline_access is never granted
    // (OIDC Core 1.0 §11 requires ignoring the request in that case).
    scope = await applyOfflineAccessPolicy(scope, effectiveParams, prompt, client, () => false);
`;
  return `/**
 * Authorization endpoint (API layer: logic only).
 *
 * processAuthorizationRequest() runs the whole OIDC Core 1.0 §3.1.2 pipeline —
 * request validation, the transaction, id_token_hint, prompt=none, SSO — and
 * reports what the endpoint decided as an outcome: the authorization response
 * URL for the client, "continue on the login / consent screen", or an error
 * that must stay on the OP. It never builds a Response; pages/authorize.ts,
 * which owns GET|POST /authorize, turns the outcome into HTTP.
 */
import {
  resolveClientForAuthorization,
  validateRegisteredRedirectUris,${requestObjectImports}
  resolveAuthorizationRedirectUri,
  rejectUnsupportedRequestParams,
  validateResponseType,
  validateAuthorizationScope,
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
  type JwkSet,${jarmCoreImports}${customScopeCoreImports}
} from '${corePkg}';
import { clientResolver as defaultClientResolver } from '../resolvers.js';
import {
  transactionStore as defaultTransactionStore,
  authCodeStore as defaultAuthCodeStore,
  authSessionStore as defaultAuthSessionStore,
  buildTransactionCookie,
} from '../store.js';${parImports}${jarmImports}${customScopeImports}

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

${buildRedirectHelpers}

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
}

/**
 * Process one authorization request (OIDC Core 1.0 Section 3.1.2). Shared by
 * GET and POST /authorize (pages/authorize.ts).
 */
export async function processAuthorizationRequest(c: any): Promise<AuthorizationOutcome> {
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

${parParamsBinding}${jarmResponseBinding}

  try {
${parResolveStep}    const clientResolver = c.get('clientResolver') ?? defaultClientResolver;
    const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
    const authCodeStore = c.get('authCodeStore') ?? defaultAuthCodeStore;
    // RFC 9207 §2: include the issuer identifier on every authorization
    // response (success and error) so clients can pin the issuer that
    // produced the response.
    const config = c.get('config');
    const issuer = config.issuer;

    // --- Authorization request validation pipeline ---------------------------
    // Each step below is an independent core function, called in OIDC Core 1.0
    // §3.1.2 order. Delete a call to drop that validation, or insert your own
    // logic between steps. Steps that run before
    // redirectUri is resolved throw non-redirectable errors (shown to the user
    // agent); steps after it throw redirectable errors (sent to the client).

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
      acrValues: effectiveParams.acr_values,
      loginHint: effectiveParams.login_hint,
      idTokenHint: effectiveParams.id_token_hint,
      audience,
      claims,
    };

    // Create authentication transaction. csrfToken is embedded in the login /
    // consent forms; transactionId never leaves the OP except in the HttpOnly
    // transaction cookie (buildTransactionCookie() in store.ts).
    const csrfToken = await generateRandomString(32);
    const transaction = createAuthTransaction(validatedRequest, csrfToken);
    const transactionId = await generateRandomString(32);

    // Store transaction
    const transactionTtlSeconds = 10 * 60; // 10 minutes TTL
    await transactionStore.put(
      'auth_txn:' + transactionId,
      ${jarmTransactionPutArg}
      transactionTtlSeconds,
    );

    // OIDC Core 1.0 Section 3.1.2.1: prompt is a space-delimited list
    const promptValues = transaction.prompt?.trim().split(/\\s+/).filter(Boolean) ?? [];

    // prompt=none must not be combined with other values (OIDC Core 1.0 Section 3.1.2.1)
    if (promptValues.includes('none') && promptValues.length > 1) {
      await transactionStore.delete('auth_txn:' + transactionId);
      return { kind: 'authorization_response', location: ${jarmAwait}buildErrorRedirect(${jarmErrorArg}transaction.redirectUri, 'invalid_request', transaction.state, 'prompt=none must not be combined with other prompt values', issuer) };
    }

    // OIDC Core 1.0 §3.1.2.1: the id_token_hint rule ("if the End-User identified
    // by the ID Token is logged in ... otherwise it SHOULD return an error") is NOT
    // conditioned on prompt, so the hint is verified here — outside the prompt=none
    // branch — and therefore on every prompt path (no prompt / login / consent /
    // select_account / none). Verification covers signature, iss, aud, exp and iat;
    // the verified subject is shared by the prompt=none check below and by the SSO
    // fast path, so an unverified hint never reaches a session decision.
    let verifiedHintSubject: string | undefined;
    if (transaction.idTokenHint !== undefined) {
      const jwksProvider = c.get('jwksProvider') as undefined | (() => Promise<JwkSet> | JwkSet);
      if (!jwksProvider) {
        // jwksProvider 未提供では hint を検証できない → login_required で拒否
        await transactionStore.delete('auth_txn:' + transactionId);
        return { kind: 'authorization_response', location: ${jarmAwait}buildErrorRedirect(${jarmErrorArg}transaction.redirectUri, 'login_required', transaction.state, 'jwksProvider is not configured; cannot verify id_token_hint', issuer) };
      }
      try {
        const jwks = await jwksProvider();
        const verified = await validateIdTokenHint(transaction.idTokenHint, {
          expectedIss: issuer,
          expectedAud: transaction.clientId,
          jwks,
        });
        verifiedHintSubject = verified.sub;
      } catch (hintError) {
        await transactionStore.delete('auth_txn:' + transactionId);
        const code = hintError instanceof IdTokenHintError ? hintError.error : 'login_required';
        return { kind: 'authorization_response', location: ${jarmAwait}buildErrorRedirect(${jarmErrorArg}transaction.redirectUri, code, transaction.state, hintError instanceof Error && hintError.message ? hintError.message : 'id_token_hint verification failed', issuer) };
      }
    }

    // prompt=none: silent authentication without any user interaction
    // OIDC Core 1.0 Section 3.1.2.1
    if (promptValues.includes('none')) {
      const sessionResolver = c.get('sessionResolver');
      const consentResolver = c.get('consentResolver');

      // No sessionResolver configured → cannot verify session → login_required
      if (!sessionResolver) {
        await transactionStore.delete('auth_txn:' + transactionId);
        return { kind: 'authorization_response', location: ${jarmAwait}buildErrorRedirect(${jarmErrorArg}transaction.redirectUri, 'login_required', transaction.state, 'sessionResolver is not configured; cannot satisfy prompt=none', issuer) };
      }

      // No consentResolver configured → cannot confirm consent → consent_required
      // (OIDC Core 1.0 Section 3.1.2.1: prompt=none must not display consent screen)
      if (!consentResolver) {
        await transactionStore.delete('auth_txn:' + transactionId);
        return { kind: 'authorization_response', location: ${jarmAwait}buildErrorRedirect(${jarmErrorArg}transaction.redirectUri, 'consent_required', transaction.state, 'consentResolver is not configured; cannot satisfy prompt=none', issuer) };
      }

      let session;
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
        validatePromptNoneIdTokenHint(transaction, session, verifiedHintSubject);
${promptNoneUserScopeStep}
        // OIDC Core 1.0 §3.1.2.1: not consented → consent_required (the OP must
        // not show a consent screen for prompt=none).
        await validatePromptNoneConsent(transaction, session, consentResolver);
      } catch (promptError) {
        await transactionStore.delete('auth_txn:' + transactionId);
        if (promptError instanceof AuthorizationError) {
          return { kind: 'authorization_response', location: ${jarmAwait}buildErrorRedirect(${jarmErrorArg}transaction.redirectUri, promptError.error, transaction.state, promptError.errorDescription, issuer) };
        }
        const serverDescription =
          promptError instanceof Error && promptError.message
            ? promptError.message
            : 'Unexpected error while evaluating prompt=none';
        return { kind: 'authorization_response', location: ${jarmAwait}buildErrorRedirect(${jarmErrorArg}transaction.redirectUri, 'server_error', transaction.state, serverDescription, issuer) };
      }

      // Check max_age: if session is too old, prompt=none cannot trigger re-authentication
      // OIDC Core 1.0 Section 3.1.2.1
      if (transaction.maxAge !== undefined && requiresReauthentication(transaction.maxAge, session.authTime)) {
        await transactionStore.delete('auth_txn:' + transactionId);
        return { kind: 'authorization_response', location: ${jarmAwait}buildErrorRedirect(${jarmErrorArg}transaction.redirectUri, 'login_required', transaction.state, 'Session exceeds the requested max_age; re-authentication required', issuer) };
      }

      // transaction.scope は認可リクエスト検証時に applyOfflineAccessPolicy を通した
      // 後の値。offline_access の可否（OIDC Core 1.0 §11 の prompt=consent と、
      // クライアント登録 grant_types に refresh_token があるか）はそこで判定済みなので、
      // ここで再フィルタしない。
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
      await consentResolver.recordGrant?.(
        session.subject,
        transaction.clientId,
        authCodeData.grantId,
      );

${promptNoneSuccessRedirect}
    }

    // OIDC Core 1.0 Section 3.1.2.3: an active OP session enables Single Sign-On.
    // Reuse it (skipping the login screen) unless prompt forces fresh auth.
    // - When max_age is requested, the session must also satisfy the freshness
    //   bound (Section 3.1.2.1).
    // - When max_age is absent, any active session is reused (SSO).
    // prompt=login / prompt=select_account always force re-authentication.
    if (!promptValues.includes('login') && !promptValues.includes('select_account')) {
      const sessionResolver = c.get('sessionResolver');
      if (sessionResolver) {
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
        if (existingSession && sessionIsFresh && hintMatchesSession) {
          // OIDC Core 1.0 §3.1.2.1: prompt=consent MUST re-display the consent UI.
          // Otherwise, if the user already granted (a superset of) the requested
          // scopes to this client, skip the consent screen and issue the code
          // directly — the interactive analogue of the prompt=none silent path.
          const consentResolver = c.get('consentResolver');
${ssoUserScopeStep}          const requestedScopes = transaction.scope.split(' ').filter(Boolean);
          const consentAlreadyGranted =
            !promptValues.includes('consent') &&
            consentResolver !== undefined &&
            (await consentResolver.hasConsent(
              existingSession.subject,
              transaction.clientId,
              requestedScopes,
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
            await consentResolver.recordGrant?.(
              existingSession.subject,
              transaction.clientId,
              authCodeData.grantId,
            );

${ssoSuccessRedirect}
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
        }
      }
    }

    // Interactive authentication: continue on the login screen (pages/login.ts;
    // prompt=login forces re-authentication there), which finds the transaction
    // through the cookie that travels with this answer.
    return { kind: 'login', cookies: [buildTransactionCookie(transactionId, transactionTtlSeconds)] };
  } catch (error) {
${parCatchBranch}    if (error instanceof AuthorizationError) {
${catchErrorRedirect}
      // OIDC Core 1.0 §3.1.2.2: errors that cannot be redirected (unknown
      // client_id, unregistered redirect_uri, redirect_uri with a fragment) MUST
      // NOT redirect to the supplied redirect_uri. They stay on the OP:
      // pages/authorize.ts answers programmatic callers (Accept:
      // application/json) with the OAuth error JSON and browsers with the OP's
      // own error page.
      return { kind: 'error', error: error.error, errorDescription: error.errorDescription };
    }
    return { kind: 'server_error' };
  }
}
`;
}

/**
 * Pushed Authorization Requests endpoint (RFC 9126).
 * Generated only when the experimental `par` feature is enabled.
 */
export function parRouteTemplate(corePkg: string): string {
  return `/**
 * EXPERIMENTAL — Pushed Authorization Requests (RFC 9126).
 *
 * This route was generated because the OP was created with \`--enable par\`.
 * It is backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * The client POSTs the authorization request parameters here (back channel,
 * authenticated) and receives a short-lived \`request_uri\` reference that it
 * then passes to /authorize.
 */
import { Hono } from 'hono';
import {
  ParError,
  assertParExpiresInSeconds,
  authenticateParClient,
  buildPushedAuthorizationResponse,
  createPushedAuthorizationRecord,
  rejectForbiddenParParams,
  validatePushedAuthorizationParams,
} from '${EXPERIMENTAL_PACKAGE}/par';
import { sanitizeErrorDescription } from '${corePkg}';
import { clientResolver as defaultClientResolver } from '../resolvers.js';
import { parStore as defaultParStore } from '../store.js';

/**
 * PAR settings. Imported by the authorize route, so keep both files in sync when
 * changing them.
 *
 * - expiresInSeconds: request_uri lifetime. RFC 9126 §2.2 recommends 5–600
 *   seconds; values outside that range fail fast at module load.
 * - requirePushedAuthorizationRequests: RFC 9126 §5. When true, /authorize
 *   rejects any request that did not go through this endpoint, and discovery
 *   advertises require_pushed_authorization_requests: true.
 */
export const parConfig = {
  expiresInSeconds: 60,
  requirePushedAuthorizationRequests: false,
};

assertParExpiresInSeconds(parConfig.expiresInSeconds);

export const parApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * RFC 9126 §2.1: the pushed authorization request body MUST be
 * application/x-www-form-urlencoded.
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

/**
 * Pushed Authorization Request Endpoint
 * RFC 9126 §2
 *
 * NOTE (RFC 9126 §2.3): request size limits (413) and rate limiting (429) are
 * deliberately left to the deployment layer (reverse proxy / platform), not
 * implemented here. This endpoint is unauthenticated until the client
 * credentials are checked, so put a rate limit in front of it in production.
 */
parApp.post('/', async (c) => {
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    c.header('Cache-Control', 'no-cache, no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'invalid_request', error_description: 'Pushed authorization requests must use application/x-www-form-urlencoded' }, 400);
  }

  // RFC 6749 §3.1: request parameters MUST NOT be repeated. Read the raw body so
  // URLSearchParams iteration exposes duplicates instead of silently keeping the last.
  const rawBody = await c.req.text();
  const params: Record<string, string> = {};
  const seen = new Set<string>();
  let duplicateKey: string | undefined;
  for (const [key, value] of new URLSearchParams(rawBody)) {
    if (seen.has(key)) {
      duplicateKey = key;
      break;
    }
    seen.add(key);
    params[key] = value;
  }

  if (duplicateKey !== undefined) {
    c.header('Cache-Control', 'no-cache, no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'invalid_request', error_description: \`Parameter "\${sanitizeErrorDescription(duplicateKey)}" must not be repeated\` }, 400);
  }

  const authorization = c.req.header('Authorization') ?? '';

  try {
    const clientResolver = c.get('clientResolver') ?? defaultClientResolver;
    const parStore = c.get('parStore') ?? defaultParStore;
    const config = c.get('config');

    // --- Pushed authorization request pipeline ------------------------------
    // Each step below is an independent function from ${EXPERIMENTAL_PACKAGE}/par,
    // called in RFC 9126 §2.1 order. Delete a call to drop that validation, or
    // insert your own logic between steps.

    // RFC 9126 §2.1: request_uri MUST NOT be pushed. The request parameter
    // (PAR + JAR, §3) is not supported by this generated provider.
    rejectForbiddenParParams(params);

    // RFC 9126 §2.1: authenticate exactly like the token endpoint does.
    // Public clients present only client_id (no credentials).
    const clientId = await authenticateParClient({
      params,
      authorizationHeader: authorization,
      clientResolver,
    });

    // client_id is a required authorization request parameter (RFC 9126 §2.1),
    // so pin it to the authenticated client before validating and storing.
    const pushedParams = { ...params, client_id: clientId };

    // RFC 9126 §2.1: "validate the request the same way the authorization
    // endpoint would" — an unregistered redirect_uri or a bad scope fails here,
    // before the user ever sees a screen.
    await validatePushedAuthorizationParams(pushedParams, clientResolver, {
      allowNonPkceAuthorizationCodeFlow: config.allowNonPkceAuthorizationCodeFlow,
    });

    // RFC 9126 §2.2 / §7.1: mint a cryptographically random reference value and
    // store the request under it. Client credentials are never persisted.
    const record = await createPushedAuthorizationRecord({
      clientId,
      params: pushedParams,
      store: parStore,
      expiresInSeconds: parConfig.expiresInSeconds,
    });
    const response = buildPushedAuthorizationResponse(record);

    // Never log the pushed parameters themselves: they can carry PII such as
    // login_hint, and the Authorization header carries the client_secret.

    // RFC 9126 §2.2: 201 Created with a non-cacheable JSON body.
    c.header('Cache-Control', 'no-cache, no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ request_uri: response.requestUri, expires_in: response.expiresIn }, 201);
  } catch (error) {
    c.header('Cache-Control', 'no-cache, no-store');
    c.header('Pragma', 'no-cache');
    if (error instanceof ParError) {
      // RFC 9126 §2.3: token-endpoint style JSON errors. This endpoint never redirects.
      if (error.wwwAuthenticate) {
        c.header('WWW-Authenticate', error.wwwAuthenticate);
      }
      return c.json({ error: error.code, error_description: error.errorDescription }, error.statusCode);
    }
    return c.json({ error: 'server_error' }, 500);
  }
});
`;
}

/**
 * EXPERIMENTAL — device authorization endpoint (RFC 8628 §3.1 / §3.2), generated
 * only with `--enable device-authorization-grant`.
 *
 * Also owns the shared settings module for the feature: the verification UI and
 * the discovery route import `deviceAuthorizationConfig` from here, so all three
 * read one source of truth.
 */
export function deviceAuthorizationRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
): string {
  // OIDC Core 1.0 §11: offline_access is only grantable when this provider can
  // actually issue refresh tokens. Baked in as a literal so the generated route
  // has no runtime branch on a feature that is fixed at generation time.
  const refreshTokenFeatureEnabled = features.refreshToken ? 'true' : 'false';
  // --scope: the device authorization request carries a scope like /authorize
  // does, so it answers to the same declared allow list (scopes.ts).
  const customScopesDeclared = scopes.length > 0;
  const customScopeImport = customScopesDeclared
    ? `
import { findUnsupportedScopes } from '../scopes.js';`
    : '';
  const customScopeStep = customScopesDeclared
    ? `
    // RFC 6749 §3.3: reject a scope this OP never declared, the same way
    // /authorize does. Checked after applyOfflineAccessPolicy so an
    // offline_access that the policy already dropped stays ignored rather than
    // becoming invalid_scope (OIDC Core 1.0 §11).
    const unsupportedScopes = findUnsupportedScopes(scope);
    if (unsupportedScopes.length > 0) {
      throw new DeviceAuthorizationError(
        'invalid_scope',
        'Unsupported scope: ' + unsupportedScopes.join(' '),
      );
    }
`
    : '';
  return `/**
 * EXPERIMENTAL — OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * This route was generated because the OP was created with
 * \`--enable device-authorization-grant\`. It is backed by
 * ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may change in a breaking
 * way between releases. Do not build production code on it without pinning the
 * version.
 *
 * The device (a TV app, a CLI, an IoT box) POSTs here — back channel,
 * client-authenticated — and receives a device_code it polls the token endpoint
 * with, plus a short user_code the end user types into /device on another
 * device's browser.
 *
 * NOTE (RFC 8628 §5.1): rate limiting the user_code guess surface is deliberately
 * left to the deployment layer (reverse proxy / platform), not implemented here.
 * An in-process counter cannot work on runtimes without shared memory between
 * instances (Cloudflare Workers and friends), so putting one here would give a
 * false sense of protection. The in-band defenses are the 20^8 user_code
 * entropy, the short TTL, and answering every failed match identically.
 */
import { Hono } from 'hono';
import {
  DeviceAuthorizationError,
  applyOfflineAccessPolicy,
  buildDeviceAuthorizationResponse,
  createDeviceAuthorizationRecord,
  validateDeviceAuthorizationScope,
  validateDeviceGrantAllowed,
} from '${EXPERIMENTAL_PACKAGE}/device-authorization-grant';
import {
  TokenError,
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  sanitizeErrorDescription,
  validateClientAuthMethod,
  verifyClientSecret,
} from '${corePkg}';
import { tokenClientResolver as defaultTokenClientResolver } from '../resolvers.js';
import { deviceAuthorizationStore as defaultDeviceAuthorizationStore } from '../store.js';${customScopeImport}

/**
 * EXPERIMENTAL — Device Authorization Grant settings (RFC 8628).
 *
 * Imported by the verification UI and the discovery route, so keep all three in
 * sync when changing them.
 *
 * - deviceCodeExpiresIn: §3.2 expires_in, in seconds. Keep it short: it is the
 *   window in which a user_code can be guessed (§5.1) or phished (§5.4).
 * - pollInterval: §3.2 interval, in seconds. The token endpoint raises a
 *   record's own interval by 5 every time it answers slow_down.
 * - maxLoginAttempts: failed device logins allowed per record before it is
 *   denied. Per-record only — see the security notes in the verification route.
 *
 * Not configurable: the user_code charset (RFC 8628 §6.1 base-20) and length (8).
 * They carry the entropy claim, so they are constants in the experimental
 * package rather than something a config typo can weaken.
 */
export const deviceAuthorizationConfig = {
  deviceCodeExpiresIn: 600,
  pollInterval: 5,
  maxLoginAttempts: 5,
};

export const deviceAuthorizationApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * RFC 8628 §3.1: the device authorization request body MUST be
 * application/x-www-form-urlencoded (it follows RFC 6749 §3.2.1).
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

function noStore(c: any): void {
  // RFC 8628 §3.2 has no explicit rule, but device_code is a credential, so the
  // response follows the token response rules of RFC 6749 §5.1.
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

/**
 * Device Authorization Endpoint
 * RFC 8628 §3.1 / §3.2
 */
deviceAuthorizationApp.post('/', async (c) => {
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    noStore(c);
    return c.json({ error: 'invalid_request', error_description: 'Device authorization requests must use application/x-www-form-urlencoded' }, 400);
  }

  // RFC 6749 §3.1: request parameters MUST NOT be repeated. Read the raw body so
  // URLSearchParams iteration exposes duplicates instead of silently keeping the last.
  const rawBody = await c.req.text();
  const params: Record<string, string> = {};
  const seen = new Set<string>();
  let duplicateKey: string | undefined;
  for (const [key, value] of new URLSearchParams(rawBody)) {
    if (seen.has(key)) {
      duplicateKey = key;
      break;
    }
    seen.add(key);
    params[key] = value;
  }

  if (duplicateKey !== undefined) {
    noStore(c);
    return c.json({ error: 'invalid_request', error_description: \`Parameter "\${sanitizeErrorDescription(duplicateKey)}" must not be repeated\` }, 400);
  }

  const authorization = c.req.header('Authorization') ?? '';

  try {
    const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
    const deviceStore = c.get('deviceAuthorizationStore') ?? defaultDeviceAuthorizationStore;
    const config = c.get('config');

    // --- Client authentication pipeline -------------------------------------
    // RFC 8628 §3.1: "The client authentication requirements of Section 3.2.1 of
    // [RFC6749] apply" — so this is the same pipeline the token endpoint runs,
    // step function for step function. Public clients present only client_id.
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: authorization,
    });
    const client = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      tokenClientResolver,
    );
    validateClientAuthMethod(client, presentedCredentials);
    await verifyClientSecret(client, presentedCredentials.clientSecret);

    // --- Device authorization pipeline --------------------------------------
    // Each step below is an independent function from
    // ${EXPERIMENTAL_PACKAGE}/device-authorization-grant, called in RFC 8628 §3.1
    // order. Delete a call to drop that validation, or insert your own logic
    // between steps.

    // RFC 6749 §5.2: the client must be registered for the device_code grant.
    validateDeviceGrantAllowed(client);

    // RFC 8628 §3.1 leaves scope OPTIONAL, but this OP requires scope and openid
    // everywhere (same rule as /authorize). Requests that omit scope — legal per
    // RFC 8628 — are therefore rejected: a known, deliberate profile restriction.
    const requestedScope = validateDeviceAuthorizationScope(params['scope']);

    // OIDC Core 1.0 §11: drop offline_access when it could never be granted.
    const scope = applyOfflineAccessPolicy(requestedScope, {
      client,
      refreshTokenFeatureEnabled: ${refreshTokenFeatureEnabled},
    });
${customScopeStep}
    // RFC 8628 §3.2 / §5.2: mint a 256-bit device_code and a collision-checked
    // base-20 user_code, then store the pending record under both.
    const record = await createDeviceAuthorizationRecord({
      clientId: client.clientId,
      scope,
      store: deviceStore,
      expiresIn: deviceAuthorizationConfig.deviceCodeExpiresIn,
      interval: deviceAuthorizationConfig.pollInterval,
    });

    // Never log device_code or user_code: both are live credentials for the
    // lifetime of the record (RFC 8628 §5.1 / §5.2).

    noStore(c);
    return c.json(buildDeviceAuthorizationResponse(record, config.issuer));
  } catch (error) {
    noStore(c);
    if (error instanceof DeviceAuthorizationError) {
      // RFC 6749 §5.2 error shape. Authentication failures never reach here —
      // they are core TokenErrors, handled below with their 401.
      return c.json({ error: error.code, error_description: error.errorDescription }, error.statusCode);
    }
    if (error instanceof TokenError) {
      const status = error.statusCode as 400 | 401;
      if (error.wwwAuthenticate) {
        c.header('WWW-Authenticate', error.wwwAuthenticate);
      }
      return c.json({ error: error.error, error_description: error.errorDescription }, status);
    }
    return c.json({ error: 'server_error' }, 500);
  }
});
`;
}

/**
 * EXPERIMENTAL — device verification UI (RFC 8628 §3.3), generated only with
 * `--enable device-authorization-grant`.
 *
 * Three POST steps hang off one mount point (`/device`, `/device/login`,
 * `/device/approve`) so the whole browser-facing surface of the feature lives in
 * a single generated file that can be deleted with the feature.
 */
export function deviceVerificationRouteTemplate(
  corePkg: string,
  scopes: string[] = [],
): string {
  // The verification UI is where the device flow learns who the End-User is, so
  // it is where the scope policy (scopes.ts) is applied. With no custom scope
  // declared every interpolation below is empty.
  const customScopesDeclared = scopes.length > 0;
  const customScopeImport = customScopesDeclared
    ? `
import { resolveGrantableScopes } from '../scopes.js';`
    : '';
  const approvalPageScopes = (subject: string): string =>
    customScopesDeclared
      ? `await resolveGrantableScopes(record.scope, ${subject})`
      : 'record.scope';
  const approveNarrowStep = customScopesDeclared
    ? `
      // Apply the scope policy to what was approved. approveDeviceAuthorization()
      // copies the requested scope into approvedScope, so the policy is applied
      // to the record afterwards and persisted; the token endpoint reads
      // approvedScope, and RFC 6749 §3.3 allows a granted scope narrower than the
      // request. Write the policy in resolveGrantableScopes() (scopes.ts).
      approved.approvedScope = await resolveGrantableScopes(
        approved.approvedScope ?? approved.scope,
        session.subject,
      );
      await deviceStore.update(approved);

`
    : '';
  return `/**
 * EXPERIMENTAL — OAuth 2.0 Device Authorization Grant, verification UI
 * (RFC 8628 §3.3), API layer: logic only.
 *
 * This module was generated because the OP was created with
 * \`--enable device-authorization-grant\`. It is backed by
 * ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may change in a breaking
 * way between releases. Do not build production code on it without pinning the
 * version.
 *
 * The end user opens /device on a second device, types the user_code the first
 * device is showing, signs in, and approves or denies. The device learns the
 * outcome only by polling the token endpoint — there is no push channel.
 *
 * The three functions below are the three state-changing steps of that UI.
 * None of them builds a Response: each returns an outcome (which screen comes
 * next, with which cookies), and pages/device.ts — which also owns GET /device
 * and the POST routes — turns it into HTTP.
 *
 * ## Why every step here demands a binding cookie
 *
 * The user_code is known to whoever started the flow, and that party can be the
 * attacker. A CSRF token stored on the record is therefore not a defense: the
 * attacker can fetch a valid one by submitting their own code. What stops both
 * consent coercion (a forged approval that ships the victim's tokens to the
 * attacker's device) and login CSRF (a forged sign-in that plants the
 * attacker's session in the victim's browser) is the binding cookie minted
 * below — see buildDeviceBindingCookie() in store.ts for the full model. The
 * hidden csrf_token is kept as defense in depth, never as the only check.
 */
import {
  DeviceAuthorizationError,
  DeviceVerificationError,
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  findPendingRecordByUserCode,
  issueVerificationBinding,
  recordDeviceLoginFailure,
  validateVerificationBinding,
  validateVerificationCsrfToken,
  type DeviceAuthorizationRecord,
} from '${EXPERIMENTAL_PACKAGE}/device-authorization-grant';
import { generateRandomString } from '${corePkg}';
import {
  browserSessionStore as defaultBrowserSessionStore,
  buildClearedDeviceBindingCookie,
  buildDeviceBindingCookie,
  buildSessionCookie,
  parseDeviceBindingSecret,
  parseSessionId,
  userStore,
} from '../store.js';
import { deviceAuthorizationConfig } from './device-authorization.js';${customScopeImport}

/** What a verification step decided; pages/device.ts turns it into the next screen. */
export type DeviceOutcome =
  /**
   * The code did not match. RFC 8628 §5.1: unknown, expired and already-used
   * codes share one reason-free answer so the UI cannot reveal which codes exist.
   */
  | { kind: 'invalid_user_code'; userCode: string }
  /** A binding or CSRF failure the OP shows on its own error page. */
  | { kind: 'error'; error: string; statusCode: number }
  /** The decision step needs an OP session this browser does not have (401). */
  | { kind: 'session_required' }
  /** recordDeviceLoginFailure() denied the record: no further attempt is accepted (429). */
  | { kind: 'locked_out' }
  /** Show the sign-in form; cookies carries the binding its submission needs. */
  | { kind: 'login'; userCode: string; csrfToken: string; cookies: string[] }
  /** Wrong credentials: show the sign-in form again with the attempts left. */
  | { kind: 'invalid_credentials'; userCode: string; csrfToken: string; remainingAttempts: number }
  /** Show the approve / deny screen; cookies carries the binding and/or the new OP session. */
  | {
      kind: 'approval';
      userCode: string;
      csrfToken: string;
      clientId: string;
      scopes: string[];
      cookies: string[];
    }
  /** The decision is recorded; cookies clears the binding. */
  | { kind: 'completed'; approved: boolean; clientId: string; cookies: string[] };

/** The fields of the sign-in form. */
export interface DeviceLoginSubmission {
  userCode: string;
  csrfToken: string;
  username: string;
  password: string;
}

/** The fields of the approve / deny form. */
export interface DeviceDecisionSubmission {
  userCode: string;
  csrfToken: string;
  /** 'approve' or anything else (treated as deny). */
  decision: string;
}

/**
 * Remaining lifetime of a record, in whole seconds, never negative.
 *
 * Rounded up so the cookie always outlives the record it binds: a cookie that
 * expired first would turn a still-valid verification into an unexplained 403.
 */
function remainingTtlSeconds(record: DeviceAuthorizationRecord): number {
  return Math.max(0, Math.ceil((record.expiresAt.getTime() - Date.now()) / 1000));
}

/** Map a verification failure to the error to show; anything else is re-thrown. */
function verificationFailure(error: unknown): DeviceOutcome {
  if (error instanceof DeviceVerificationError) {
    return { kind: 'error', error: error.message, statusCode: error.statusCode };
  }
  if (error instanceof DeviceAuthorizationError) {
    return { kind: 'error', error: error.errorDescription, statusCode: 400 };
  }
  throw error;
}

/**
 * User code submission (POST /device)
 * RFC 8628 §3.3
 *
 * On a match this is where the browser binding is minted, so this is also the
 * first answer that may carry a csrf_token. Everything downstream requires the
 * cookie this outcome sets.
 */
export async function submitDeviceUserCode(c: any, submittedUserCode: string): Promise<DeviceOutcome> {
  const deviceStore = c.get('deviceAuthorizationStore');
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceStore);
  if (!record) {
    return { kind: 'invalid_user_code', userCode: submittedUserCode };
  }

  // Rotate the binding secret and the csrf token together. A second browser
  // submitting the same user_code takes the binding over (last writer wins);
  // that is inherent to a flow whose identifier is shareable by design.
  const { bindingSecret, csrfToken } = await issueVerificationBinding(record, deviceStore);
  const cookie = buildDeviceBindingCookie(
    record.userCode,
    bindingSecret,
    remainingTtlSeconds(record),
  );

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (session) {
    return {
      kind: 'approval',
      userCode: record.userCodeDisplay,
      csrfToken,
      clientId: record.clientId,
      scopes: ${approvalPageScopes('session.subject')},
      cookies: [cookie],
    };
  }

  return {
    kind: 'login',
    userCode: record.userCodeDisplay,
    csrfToken,
    cookies: [cookie],
  };
}

/**
 * Device login (POST /device/login)
 * RFC 8628 §3.3
 *
 * Binding first, then CSRF, then credentials: the binding is what proves this is
 * the browser that submitted the user_code, and it must gate the step that would
 * otherwise let a forged POST establish an OP session in the victim's browser.
 */
export async function submitDeviceLogin(c: any, input: DeviceLoginSubmission): Promise<DeviceOutcome> {
  const { userCode: submittedUserCode, csrfToken, username, password } = input;

  const deviceStore = c.get('deviceAuthorizationStore');
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const authenticateUser =
    c.get('authenticateUser') ??
    ((u: string, p: string) => userStore.authenticate(u, p));

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceStore);
  if (!record) {
    return { kind: 'invalid_user_code', userCode: submittedUserCode };
  }

  try {
    await validateVerificationBinding(
      record,
      parseDeviceBindingSecret(c.req.header('Cookie') ?? null, record.userCode),
    );
    validateVerificationCsrfToken(record, csrfToken);
  } catch (error) {
    return verificationFailure(error);
  }

  // Swap point: replace this with your own credential check (LDAP, WebAuthn, an
  // upstream IdP) without touching anything above or below it.
  const user = await authenticateUser(username, password);
  if (!user) {
    // Per-record throttling only. An attacker holding a device-grant client can
    // mint unlimited records, so the aggregate password-guess budget is the same
    // as the one on /login. Subject-scoped throttling is a separate concern.
    const failure = await recordDeviceLoginFailure(
      record,
      deviceStore,
      deviceAuthorizationConfig.maxLoginAttempts,
    );
    if (!failure.canRetry) {
      // The record is now denied: the device gets access_denied on its next poll.
      return { kind: 'locked_out' };
    }
    return {
      kind: 'invalid_credentials',
      userCode: record.userCodeDisplay,
      csrfToken,
      remainingAttempts: failure.remainingAttempts,
    };
  }

  const authTime = Math.floor(Date.now() / 1000);
  const sessionId = generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject: user.sub, authTime });

  // The new OP session travels with the approval screen; the approval step
  // will have to present the binding cookie again as well.
  return {
    kind: 'approval',
    userCode: record.userCodeDisplay,
    csrfToken,
    clientId: record.clientId,
    scopes: ${approvalPageScopes('user.sub')},
    cookies: [buildSessionCookie(sessionId)],
  };
}

/**
 * Approve or deny (POST /device/approve)
 * RFC 8628 §3.3
 *
 * The only state-changing step of the UI, so it demands all three: an OP
 * session, the binding cookie, and the csrf_token.
 */
export async function submitDeviceDecision(
  c: any,
  input: DeviceDecisionSubmission,
): Promise<DeviceOutcome> {
  const { userCode: submittedUserCode, csrfToken, decision } = input;

  const deviceStore = c.get('deviceAuthorizationStore');
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const consentResolver = c.get('consentResolver');

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceStore);
  if (!record) {
    return { kind: 'invalid_user_code', userCode: submittedUserCode };
  }

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (!session) {
    return { kind: 'session_required' };
  }

  const clearCookie = buildClearedDeviceBindingCookie(record.userCode);
  try {
    await validateVerificationBinding(
      record,
      parseDeviceBindingSecret(c.req.header('Cookie') ?? null, record.userCode),
    );

    if (decision === 'approve') {
      // csrf_token is validated inside; the record moves to approved with the
      // subject, auth_time, scope and a fresh grantId the token endpoint reads.
      const approved = await approveDeviceAuthorization({
        record,
        store: deviceStore,
        csrfToken,
        subject: session.subject,
        authTime: session.authTime,
      });
${approveNarrowStep}      // Record the consent the same way /consent does, so a later Authorization
      // Code Flow for this client skips the consent screen (OIDC Core 1.0 §3.1.2.4).
      await consentResolver?.recordConsent?.(
        approved.subject,
        approved.clientId,
        approved.approvedScope ?? approved.scope,
      );
      await consentResolver?.recordGrant?.(approved.subject, approved.clientId, approved.grantId);
      return { kind: 'completed', approved: true, clientId: approved.clientId, cookies: [clearCookie] };
    }

    await denyDeviceAuthorization({ record, store: deviceStore, csrfToken });
    return { kind: 'completed', approved: false, clientId: record.clientId, cookies: [clearCookie] };
  } catch (error) {
    return verificationFailure(error);
  }
}
`;
}

/**
 * EXPERIMENTAL — RP-Initiated Logout end_session_endpoint
 * (OpenID Connect RP-Initiated Logout 1.0), generated only with
 * `--enable rp-initiated-logout`.
 *
 * Three routes hang off one mount point (`GET|POST /logout`,
 * `POST /logout/approve`) so the whole browser-facing surface of the feature
 * lives in a single generated file that can be deleted with the feature. The
 * file also owns the feature's settings object (the post_logout_redirect_uri
 * registry), like device-authorization.ts owns deviceAuthorizationConfig.
 */
export function endSessionRouteTemplate(corePkg: string): string {
  return `/**
 * EXPERIMENTAL — OpenID Connect RP-Initiated Logout 1.0, end_session_endpoint
 * — API layer: logic only.
 *
 * This module was generated because the OP was created with
 * \`--enable rp-initiated-logout\`. It is backed by
 * ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may change in a breaking
 * way between releases. Do not build production code on it without pinning the
 * version.
 *
 * The RP sends the user agent to /logout (GET or POST, §2 MUST) to end the OP
 * browser session. A request whose id_token_hint verifies against this OP's
 * keys AND matches the current session's End-User logs out immediately; every
 * other request — no hint, an invalid or expired hint, a client_id that
 * mismatches the hint audience, no session, another user's session — falls to
 * one shared confirmation screen (§2 MUST; §7: an unauthenticated logout link
 * would otherwise be a denial-of-service primitive). The failure reason is
 * never disclosed anywhere: a reason would turn this endpoint into an oracle
 * for session state.
 *
 * Neither function below builds a Response: each returns an outcome (which
 * screen or redirect comes next, with which cookies), and pages/logout.ts —
 * which owns the GET and POST routes — turns it into HTTP.
 *
 * ## Why the confirmation approve step demands a cookie + token pair
 *
 * The approve POST ends a session, so a forged cross-site POST must not drive
 * it. When the confirmation screen is shown the OP mints a fresh secret and
 * hands it to that one browser twice: in an HttpOnly cookie and in the form's
 * hidden csrf_token. approveLogout() runs only when both come back equal. An
 * attacker can obtain a valid pair in their own browser but cannot plant that
 * cookie into the victim's, so the forged POST fails the comparison — the
 * same model as the device verification binding cookie (see store.ts).
 *
 * The cookie also carries the OP-computed post-logout redirect target, so the
 * confirmation flow never round-trips the id_token_hint (or any redirect
 * parameter) through the HTML page: the only value the form submits back is
 * the csrf_token itself.
 */
import {
  decideLogoutFlow,
  extractIdTokenHintAudience,
  parseEndSessionRequest,
  resolvePostLogoutRedirect,
} from '${EXPERIMENTAL_PACKAGE}/rp-initiated-logout';
import { IdTokenHintError, generateRandomString, validateIdTokenHint } from '${corePkg}';
import {
  browserSessionStore as defaultBrowserSessionStore,
  buildClearedLogoutConfirmationCookie,
  buildClearedSessionCookie,
  buildLogoutConfirmationCookie,
  parseLogoutConfirmation,
  parseSessionId,
} from '../store.js';
import { defaultProviderConfig } from '../config.js';

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

/** What a logout step decided; pages/logout.ts turns it into HTTP. */
export type LogoutOutcome =
  /** Forged, replayed or expired confirmation: nothing was deleted (400). */
  | { kind: 'invalid_confirmation' }
  /** §2 MUST: ask first. cookies pairs the HttpOnly secret with the form's csrf_token. */
  | { kind: 'confirmation'; csrfToken: string; cookies: string[] }
  /** Logged out; §3: return to the registered post_logout_redirect_uri (state appended). */
  | { kind: 'redirect'; location: string; cookies: string[] }
  /** Logged out; no registered redirect applied, so show the completed screen. */
  | { kind: 'completed'; cookies: string[] };

/**
 * Interpret one end_session request (§2). GET and POST share this function —
 * they differ only in where the parameters come from.
 */
export async function processEndSessionRequest(c: any, params: URLSearchParams): Promise<LogoutOutcome> {
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
        // failing) is rethrown: masking an outage as \"invalid hint\" would
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
    return {
      kind: 'confirmation',
      csrfToken: csrfSecret,
      cookies: [buildLogoutConfirmationCookie({ csrfSecret, redirectTo })],
    };
  }

  // Immediate logout: a valid hint for the current session's End-User (§2).
  // Delete the store entry and expire the cookie together.
  if (sessionId) {
    await browserSessionStore.delete(sessionId);
  }
  const cookies = [buildClearedSessionCookie()];
  if (redirectTo !== null) {
    return { kind: 'redirect', location: redirectTo, cookies };
  }
  return { kind: 'completed', cookies };
}

/**
 * Confirmation approve (POST /logout/approve)
 *
 * Runs only for the browser that saw the confirmation screen: the HttpOnly
 * cookie and the hidden csrf_token must present the same secret (neither
 * alone is accepted). On success the session is deleted and the redirect
 * decision computed when the screen was shown — carried in the cookie, never
 * in the form — is honored (§3).
 */
export async function approveLogout(c: any, csrfToken: string): Promise<LogoutOutcome> {
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;

  const confirmation = parseLogoutConfirmation(c.req.header('Cookie') ?? null);
  if (confirmation === null || csrfToken === '' || confirmation.csrfSecret !== csrfToken) {
    // Forged, replayed or expired confirmation: delete nothing.
    return { kind: 'invalid_confirmation' };
  }

  // The End-User explicitly approved (§2). When the session is already gone
  // there is nothing to delete and the answer is the same either way — the
  // confirmation flow is not an oracle for whether a session existed.
  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  if (sessionId) {
    await browserSessionStore.delete(sessionId);
  }
  const cookies = [buildClearedSessionCookie(), buildClearedLogoutConfirmationCookie()];
  if (confirmation.redirectTo !== null) {
    return { kind: 'redirect', location: confirmation.redirectTo, cookies };
  }
  return { kind: 'completed', cookies };
}
`;
}

/**
 * EXPERIMENTAL — CIBA backchannel authentication endpoint (CIBA Core 1.0 §7),
 * generated only with `--enable ciba`.
 *
 * Also owns the shared settings module for the feature: the authentication
 * device UI, the token route dispatch and the discovery route import
 * `cibaConfig` from here, so all of them read one source of truth.
 */
export function backchannelAuthenticationRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
): string {
  // OIDC Core 1.0 §11: offline_access is only grantable when this provider can
  // actually issue refresh tokens. Baked in as a literal so the generated route
  // has no runtime branch on a feature that is fixed at generation time.
  const refreshTokenFeatureEnabled = features.refreshToken ? 'true' : 'false';
  // --scope: a backchannel authentication request carries a scope like
  // /authorize does, so it answers to the same declared allow list (scopes.ts).
  const customScopesDeclared = scopes.length > 0;
  const customScopeImport = customScopesDeclared
    ? `
import { findUnsupportedScopes } from '../scopes.js';`
    : '';
  const customScopeStep = customScopesDeclared
    ? `    // RFC 6749 §3.3: reject a scope this OP never declared, the same allow list
    // /authorize uses (scopes.ts). Checked before the pipeline so a request for
    // an unknown scope never reaches the store. offline_access is left out of
    // the check: the pipeline applies its own policy and ignores it when it
    // cannot be granted (OIDC Core 1.0 §11), which must not become an error.
    const unsupportedScopes = findUnsupportedScopes(
      (params['scope'] ?? '')
        .split(' ')
        .filter((scope) => scope.length > 0 && scope !== 'offline_access'),
    );
    if (unsupportedScopes.length > 0) {
      throw new BackchannelAuthenticationError(
        'invalid_scope',
        'Unsupported scope: ' + unsupportedScopes.join(' '),
      );
    }

`
    : '';
  return `/**
 * EXPERIMENTAL — OpenID Connect Client-Initiated Backchannel Authentication
 * (CIBA Core 1.0), poll mode.
 *
 * This route was generated because the OP was created with \`--enable ciba\`.
 * It is backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * The consumption device (a call-center console, a kiosk, a smart speaker
 * backend) POSTs here — back channel, client-authenticated — with a login_hint
 * naming the user, and receives an auth_req_id it polls the token endpoint
 * with. The user approves or denies on their own browser at /ciba.
 *
 * NOTE (CIBA §15): the login_hint is a user identifier and therefore PII.
 * Never log it, and never echo it in an error_description. Rate limiting the
 * endpoint as a whole is deliberately left to the deployment layer (reverse
 * proxy / platform): an in-process counter cannot work on runtimes without
 * shared memory between instances. The in-band defenses are mandatory client
 * authentication, the fixed unknown_user_id wording, and the per-subject
 * pending-request cap below.
 */
import { Hono } from 'hono';
import {
  BackchannelAuthenticationError,
  processBackchannelAuthenticationRequest,
  type CibaClientInfo,
} from '${EXPERIMENTAL_PACKAGE}/ciba';
import {
  TokenError,
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  sanitizeErrorDescription,
  validateClientAuthMethod,
  verifyClientSecret,
} from '${corePkg}';
import { tokenClientResolver as defaultTokenClientResolver } from '../resolvers.js';
import {
  cibaAuthenticationRequestStore as defaultCibaAuthenticationRequestStore,
  userStore,
} from '../store.js';${customScopeImport}

/**
 * EXPERIMENTAL — CIBA settings (CIBA Core 1.0).
 *
 * Imported by the authentication device UI, the token route and the discovery
 * route, so keep all of them in sync when changing them.
 *
 * - authReqIdExpiresIn: §7.3 expires_in, in seconds (range 30–600). Keep it
 *   short: it is the window the user has to approve, and the window in which a
 *   pending request can pile up on the approval screen.
 * - pollingInterval: §7.3 interval, in seconds (range 1–60). The token endpoint
 *   raises a record's own interval by 5 every time it answers slow_down (§11).
 * - maxPendingPerSubject: pending backchannel requests allowed per user (range
 *   1–100) before new ones are refused — the flood defense for the approval
 *   screen (the role §7.1.2's unsupported user_code would otherwise play).
 * - maxLoginAttempts: failed /ciba logins allowed per login transaction before
 *   it is discarded. Per-transaction only — see the notes in the UI route.
 */
export const cibaConfig = {
  authReqIdExpiresIn: 120,
  pollingInterval: 5,
  maxPendingPerSubject: 10,
  maxLoginAttempts: 5,
};

// Fail fast on a config edit that leaves the documented ranges: a typo here
// weakens either the approval-screen flood cap or the polling contract.
if (cibaConfig.authReqIdExpiresIn < 30 || cibaConfig.authReqIdExpiresIn > 600) {
  throw new Error('cibaConfig.authReqIdExpiresIn must be between 30 and 600 seconds');
}
if (cibaConfig.pollingInterval < 1 || cibaConfig.pollingInterval > 60) {
  throw new Error('cibaConfig.pollingInterval must be between 1 and 60 seconds');
}
if (cibaConfig.maxPendingPerSubject < 1 || cibaConfig.maxPendingPerSubject > 100) {
  throw new Error('cibaConfig.maxPendingPerSubject must be between 1 and 100');
}

export const backchannelAuthenticationApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * CIBA §7.1: the backchannel authentication request body MUST be
 * application/x-www-form-urlencoded.
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

function noStore(c: any): void {
  // auth_req_id is a credential, so the response follows the token response
  // rules of RFC 6749 §5.1 / §5.2.
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

/**
 * Backchannel Authentication Endpoint
 * CIBA Core 1.0 §7.1 / §7.2 / §7.3
 */
backchannelAuthenticationApp.post('/', async (c) => {
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    noStore(c);
    return c.json({ error: 'invalid_request', error_description: 'Backchannel authentication requests must use application/x-www-form-urlencoded' }, 400);
  }

  // RFC 6749 §3.1: request parameters MUST NOT be repeated. Read the raw body so
  // URLSearchParams iteration exposes duplicates instead of silently keeping the last.
  const rawBody = await c.req.text();
  const params: Record<string, string> = {};
  const seen = new Set<string>();
  let duplicateKey: string | undefined;
  for (const [key, value] of new URLSearchParams(rawBody)) {
    if (seen.has(key)) {
      duplicateKey = key;
      break;
    }
    seen.add(key);
    params[key] = value;
  }

  if (duplicateKey !== undefined) {
    noStore(c);
    return c.json({ error: 'invalid_request', error_description: \`Parameter "\${sanitizeErrorDescription(duplicateKey)}" must not be repeated\` }, 400);
  }

  const authorization = c.req.header('Authorization') ?? '';

  try {
    const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
    const cibaStore = c.get('cibaAuthenticationRequestStore') ?? defaultCibaAuthenticationRequestStore;

    // --- Client authentication pipeline -------------------------------------
    // CIBA §7.1: "The Client MUST authenticate ... using the authentication
    // method registered for its client_id" — the same pipeline the token
    // endpoint runs, step function for step function.
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: authorization,
    });
    const client = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      tokenClientResolver,
    );
    validateClientAuthMethod(client, presentedCredentials);
    await verifyClientSecret(client, presentedCredentials.clientSecret);

    // login_hint → subject resolution is the deployment's swap point: the
    // default (wired in app.ts) treats the hint as a username of the configured
    // user store. Replace c.set('cibaUserResolver', ...) — or the fallback
    // below — to resolve email addresses, phone numbers, or your own ids.
    const resolveUser =
      c.get('cibaUserResolver') ??
      (async (loginHint: string) => {
        const claims = await userStore.getClaims(loginHint);
        return claims ? { subject: claims.sub } : null;
      });

${customScopeStep}    // --- Backchannel authentication pipeline --------------------------------
    // Validation runs in CIBA §7.1 order inside the experimental package:
    // client checks (public client / grant registration / delivery mode) →
    // request parameter rejection → the one-and-only-one hint rule → scope →
    // binding_message → requested_expiry → login_hint resolution → the
    // per-subject pending cap → record creation.
    const response = await processBackchannelAuthenticationRequest({
      params,
      client: client as CibaClientInfo,
      store: cibaStore,
      config: cibaConfig,
      refreshTokenFeatureEnabled: ${refreshTokenFeatureEnabled},
      resolveUser,
    });

    // Never log auth_req_id (a live credential) or login_hint (PII, CIBA §15).

    noStore(c);
    return c.json(response);
  } catch (error) {
    noStore(c);
    if (error instanceof BackchannelAuthenticationError) {
      // CIBA §13 / RFC 6749 §5.2 error shape. Authentication failures never
      // reach here — they are core TokenErrors, handled below with their 401.
      return c.json({ error: error.code, error_description: error.errorDescription }, error.statusCode);
    }
    if (error instanceof TokenError) {
      const status = error.statusCode as 400 | 401;
      if (error.wwwAuthenticate) {
        c.header('WWW-Authenticate', error.wwwAuthenticate);
      }
      return c.json({ error: error.error, error_description: error.errorDescription }, status);
    }
    return c.json({ error: 'server_error' }, 500);
  }
});
`;
}

/**
 * EXPERIMENTAL — CIBA authentication device UI, generated only with
 * `--enable ciba`.
 *
 * The GET listing / login form and the two POST steps hang off one mount point
 * (`/ciba`, `/ciba/login`, `/ciba/approve`) so the whole browser-facing surface
 * of the feature lives in a single generated file that can be deleted with the
 * feature.
 */
export function cibaVerificationRouteTemplate(
  corePkg: string,
  scopes: string[] = [],
): string {
  // The authentication device UI is where CIBA learns who the End-User is, so it
  // is where the scope policy (scopes.ts) is applied.
  const customScopesDeclared = scopes.length > 0;
  const customScopeImport = customScopesDeclared
    ? `
import { resolveGrantableScopes } from '../scopes.js';`
    : '';
  // The policy is async, so the listing resolves its rows before answering.
  const pendingRequestRows = customScopesDeclared
    ? `  return Promise.all(
    pending.map(async (record) => ({
      authReqId: record.authReqId,
      clientId: record.clientId,
      // Show only what this End-User can actually grant (scopes.ts).
      scopes: await resolveGrantableScopes(record.scope, subject),
      bindingMessage: record.bindingMessage,
      expiresInSeconds: remainingSeconds(record.expiresAt),
      csrfToken: record.csrfToken ?? '',
    })),
  );`
    : `  return pending.map((record) => ({
    authReqId: record.authReqId,
    clientId: record.clientId,
    scopes: record.scope,
    bindingMessage: record.bindingMessage,
    expiresInSeconds: remainingSeconds(record.expiresAt),
    csrfToken: record.csrfToken ?? '',
  }));`;
  const approveNarrowStep = customScopesDeclared
    ? `      // Apply the scope policy to what was approved. approveCibaRequest()
      // copies the requested scope into approvedScope, so the policy is applied
      // to the record afterwards and persisted; the token endpoint reads
      // approvedScope, and RFC 6749 §3.3 allows a granted scope narrower than the
      // request. Write the policy in resolveGrantableScopes() (scopes.ts).
      approved.approvedScope = await resolveGrantableScopes(
        approved.approvedScope ?? approved.scope,
        session.subject,
      );
      await cibaStore.update(approved);

`
    : '';
  return `/**
 * EXPERIMENTAL — OpenID Connect Client-Initiated Backchannel Authentication
 * (CIBA Core 1.0), authentication device UI — API layer: logic only.
 *
 * This module was generated because the OP was created with \`--enable ciba\`.
 * It is backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * CIBA Core leaves the authentication device — how the user is reached and how
 * they authenticate — outside the specification (§7.1). This UI implements it
 * as an OP-hosted browser page the user visits themselves: sign in at /ciba,
 * review the pending requests addressed to you (client, scopes,
 * binding_message), and approve or deny. The consumption device learns the
 * outcome only by polling the token endpoint — there is no push channel in
 * poll mode.
 *
 * The three functions below are the three steps of that UI. None of them
 * builds a Response: each returns an outcome (which screen comes next, with
 * which cookies), and pages/ciba.ts — which owns the GET and POST routes —
 * turns it into HTTP.
 *
 * ## Why the login form demands a binding cookie
 *
 * A successful login establishes an OP session, whose reach goes beyond CIBA
 * (SSO, prompt=none). A hidden csrf_token alone cannot stop login CSRF: the
 * attacker fetches their own login form, reads a valid transaction id + token
 * pair, and embeds both in a forged cross-site POST — planting the attacker's
 * session in the victim's browser. The login transaction's binding cookie
 * (minted below, hash-stored) is what stops it — see
 * buildCibaLoginBindingCookie() in store.ts for the full model.
 *
 * ## Why approve / deny does NOT use a binding cookie
 *
 * The approval is already bound to the authenticated OP session: the record's
 * subject must equal the session subject, and the per-record csrf_token is only
 * ever rendered on the session-gated listing. Knowing an auth_req_id gives an
 * attacker no step to forge.
 */
import {
  CibaVerificationError,
  approveCibaRequest,
  createCibaLoginTransaction,
  denyCibaRequest,
  listPendingCibaRequests,
  recordCibaLoginFailure,
  validateCibaLoginSubmission,
} from '${EXPERIMENTAL_PACKAGE}/ciba';
import { generateRandomString } from '${corePkg}';
import {
  browserSessionStore as defaultBrowserSessionStore,
  buildCibaLoginBindingCookie,
  buildClearedCibaLoginBindingCookie,
  buildSessionCookie,
  cibaAuthenticationRequestStore as defaultCibaAuthenticationRequestStore,
  cibaLoginTransactionStore as defaultCibaLoginTransactionStore,
  parseCibaLoginBindingSecret,
  parseSessionId,
  userStore,
} from '../store.js';
import { cibaConfig } from './backchannel-authentication.js';${customScopeImport}

/** One pending backchannel authentication request, as the approval screen shows it. */
export interface CibaPendingRequest {
  /** auth_req_id; posted back by the decision form. */
  authReqId: string;
  clientId: string;
  /** Scopes this End-User is asked to grant (already narrowed by the scope policy). */
  scopes: string[];
  /** CIBA Core 1.0 §7.1 binding_message, client-supplied: escape before rendering. */
  bindingMessage?: string;
  expiresInSeconds: number;
  /** Per-record CSRF token; posted back by the decision form. */
  csrfToken: string;
}

/** What a step of the UI decided; pages/ciba.ts turns it into the next screen. */
export type CibaOutcome =
  /** A binding or CSRF failure the OP shows on its own error page. */
  | { kind: 'error'; error: string; statusCode: number }
  /** The decision step needs an OP session this browser does not have (401). */
  | { kind: 'session_required' }
  /** decision was neither approve nor deny (400). */
  | { kind: 'invalid_decision' }
  /** recordCibaLoginFailure() discarded the login transaction: no further attempt (429). */
  | { kind: 'locked_out' }
  /** Show the sign-in form; cookies carries the binding its submission needs. */
  | { kind: 'login'; loginTransactionId: string; csrfToken: string; cookies: string[] }
  /** Wrong credentials: show the sign-in form again with the attempts left. */
  | {
      kind: 'invalid_credentials';
      loginTransactionId: string;
      csrfToken: string;
      remainingAttempts: number;
    }
  /** Show the signed-in user's pending requests; cookies carries a new OP session, if any. */
  | { kind: 'pending_requests'; requests: CibaPendingRequest[]; cookies: string[] }
  /** The decision is recorded. */
  | { kind: 'completed'; approved: boolean; clientId: string };

/** The fields of the sign-in form. */
export interface CibaLoginSubmission {
  loginTransactionId: string;
  csrfToken: string;
  username: string;
  password: string;
}

/** The fields of the approve / deny form. */
export interface CibaDecisionSubmission {
  authReqId: string;
  csrfToken: string;
  /** 'approve' or 'deny'. */
  decision: string;
}

/** Map a verification failure to the error to show; anything else is re-thrown. */
function verificationFailure(error: unknown): CibaOutcome {
  if (error instanceof CibaVerificationError) {
    return { kind: 'error', error: error.message, statusCode: error.statusCode };
  }
  throw error;
}

/** Remaining lifetime of a pending request, in whole seconds, never negative. */
function remainingSeconds(expiresAt: Date): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
}

/**
 * The session subject's pending requests with freshly rotated CSRF tokens (the
 * only place those tokens are ever exposed, and it is session-gated).
 */
async function listPendingRequests(c: any, subject: string): Promise<CibaPendingRequest[]> {
  const cibaStore = c.get('cibaAuthenticationRequestStore') ?? defaultCibaAuthenticationRequestStore;
  const pending = await listPendingCibaRequests({ subject, store: cibaStore });
${pendingRequestRows}
}

/**
 * Listing / login form (GET /ciba)
 *
 * With an OP session: the pending requests addressed to the signed-in user.
 * Without one: mint a login transaction and describe the sign-in form, with the
 * binding cookie its submission needs.
 */
export async function prepareCibaDevice(c: any): Promise<CibaOutcome> {
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const loginTransactionStore =
    c.get('cibaLoginTransactionStore') ?? defaultCibaLoginTransactionStore;

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (session) {
    return { kind: 'pending_requests', requests: await listPendingRequests(c, session.subject), cookies: [] };
  }

  const { record, bindingSecret } = await createCibaLoginTransaction(loginTransactionStore);
  const cookie = buildCibaLoginBindingCookie(
    record.id,
    bindingSecret,
    remainingSeconds(record.expiresAt),
  );
  return {
    kind: 'login',
    loginTransactionId: record.id,
    csrfToken: record.csrfToken,
    cookies: [cookie],
  };
}

/**
 * Sign in (POST /ciba/login)
 *
 * Binding first, then CSRF, then credentials: the binding is what proves this
 * is the browser the login form was issued to, and it must gate the step that
 * would otherwise let a forged POST establish an OP session in the victim's
 * browser.
 */
export async function submitCibaLogin(c: any, input: CibaLoginSubmission): Promise<CibaOutcome> {
  const { loginTransactionId: transactionId, csrfToken, username, password } = input;

  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const loginTransactionStore =
    c.get('cibaLoginTransactionStore') ?? defaultCibaLoginTransactionStore;
  const authenticateUser =
    c.get('authenticateUser') ??
    ((u: string, p: string) => userStore.authenticate(u, p));

  let transaction;
  try {
    transaction = await validateCibaLoginSubmission({
      transactionId,
      csrfToken,
      bindingSecret: parseCibaLoginBindingSecret(c.req.header('Cookie') ?? null, transactionId),
      store: loginTransactionStore,
    });
  } catch (error) {
    return verificationFailure(error);
  }

  // Swap point: replace this with your own credential check (LDAP, WebAuthn, an
  // upstream IdP) without touching anything above or below it.
  const user = await authenticateUser(username, password);
  if (!user) {
    // Per-transaction throttling only. Anyone can mint fresh login
    // transactions by reloading /ciba, so the aggregate password-guess budget
    // is the same as the one on /login. Subject-scoped throttling is a
    // separate concern.
    const failure = await recordCibaLoginFailure(
      transaction,
      loginTransactionStore,
      cibaConfig.maxLoginAttempts,
    );
    if (!failure.canRetry) {
      // The transaction is gone: this form cannot be retried at all.
      return { kind: 'locked_out' };
    }
    return {
      kind: 'invalid_credentials',
      loginTransactionId: transaction.id,
      csrfToken: transaction.csrfToken,
      remainingAttempts: failure.remainingAttempts,
    };
  }

  // The transaction is single-use: a successful login consumes it, and the
  // session is established under a NEWLY minted id (never one the request
  // brought along — session fixation).
  await loginTransactionStore.delete(transaction.id);
  const authTime = Math.floor(Date.now() / 1000);
  const sessionId = generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject: user.sub, authTime });

  // Two cookies travel with the listing: the new OP session, and the cleared
  // login binding (it is single-use and would otherwise linger until Max-Age).
  return {
    kind: 'pending_requests',
    requests: await listPendingRequests(c, user.sub),
    cookies: [buildSessionCookie(sessionId), buildClearedCibaLoginBindingCookie(transaction.id)],
  };
}

/**
 * Approve or deny (POST /ciba/approve)
 *
 * The only state-changing step of the UI. It demands an OP session whose
 * subject owns the record, plus the per-record csrf_token from the
 * session-gated listing.
 */
export async function submitCibaDecision(c: any, input: CibaDecisionSubmission): Promise<CibaOutcome> {
  const { authReqId, csrfToken, decision } = input;

  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const cibaStore = c.get('cibaAuthenticationRequestStore') ?? defaultCibaAuthenticationRequestStore;
  const consentResolver = c.get('consentResolver');

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;
  if (!session) {
    return { kind: 'session_required' };
  }

  if (decision !== 'approve' && decision !== 'deny') {
    return { kind: 'invalid_decision' };
  }

  try {
    if (decision === 'approve') {
      // subject and csrf_token are validated inside; the record moves to
      // approved with auth_time, scope and a fresh grantId the token endpoint
      // reads.
      const approved = await approveCibaRequest({
        authReqId,
        subject: session.subject,
        csrfToken,
        authTime: session.authTime,
        grantId: generateRandomString(32),
        store: cibaStore,
      });
${approveNarrowStep}      // Record the consent the same way /consent does, so a later Authorization
      // Code Flow for this client skips the consent screen (OIDC Core 1.0 §3.1.2.4).
      await consentResolver?.recordConsent?.(
        approved.subject,
        approved.clientId,
        approved.approvedScope ?? approved.scope,
      );
      await consentResolver?.recordGrant?.(approved.subject, approved.clientId, approved.grantId);
      return { kind: 'completed', approved: true, clientId: approved.clientId };
    }

    const record = await cibaStore.findByAuthReqId(authReqId);
    await denyCibaRequest({
      authReqId,
      subject: session.subject,
      csrfToken,
      store: cibaStore,
    });
    return { kind: 'completed', approved: false, clientId: record?.clientId ?? '' };
  } catch (error) {
    return verificationFailure(error);
  }
}
`;
}

/**
 * EXPERIMENTAL — JARM settings module, generated only with `--enable jarm`.
 *
 * Kept in its own file (rather than config.ts) so the JARM feature can be
 * removed by deleting the files it generated, and so the authorize and consent
 * routes read one shared setting.
 */
export function jarmConfigTemplate(): string {
  return `/**
 * EXPERIMENTAL — JWT Secured Authorization Response Mode (JARM).
 *
 * This module was generated because the OP was created with \`--enable jarm\`.
 * It is backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * Imported by the authorize and consent routes, so keep all three in sync when
 * changing these settings.
 *
 * - jarmResponseLifetimeSeconds: how long the response JWT stays valid (its
 *   \`exp\` claim). JARM Section 2.1 RECOMMENDs a maximum lifetime of 10 minutes,
 *   so values outside 5-600 seconds fail fast at module load. Keep it short: the
 *   JWT rides in a URL and only needs to survive one browser redirect.
 *
 * Not configurable: the signing algorithm (RS256, JARM Section 3's default for a
 * client with no registered authorization_signed_response_alg), the response
 * parameter name (\`response\`, JARM Section 2.3.1) and the supported response
 * modes (\`query.jwt\` / \`jwt\` — this OP implements response_type=code only, so
 * \`fragment.jwt\` and \`form_post.jwt\` are rejected with invalid_request).
 */
import { assertJarmLifetimeSeconds } from '${EXPERIMENTAL_PACKAGE}/jarm';

export const jarmConfig = {
  jarmResponseLifetimeSeconds: 60,
};

assertJarmLifetimeSeconds(jarmConfig.jarmResponseLifetimeSeconds);
`;
}

export function tokenRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const refreshResolverImport = features.refreshToken
    ? `
  refreshTokenResolver as defaultRefreshTokenResolver,
  authenticationSessionResolver as defaultAuthenticationSessionResolver,`
    : '';
  const refreshStoreImport = features.refreshToken
    ? `
  refreshTokenStore as defaultRefreshTokenStore,`
    : '';
  const refreshResolverConst = features.refreshToken
    ? `    const refreshTokenResolver =
      c.get('refreshTokenResolver') ?? defaultRefreshTokenResolver;
    // online refresh token の束縛先セッションを sessionId から引く。差し替えると
    // 「セッションが生きているか」の判定そのものを差し替えられる。
    const authenticationSessionResolver =
      c.get('authenticationSessionResolver') ?? defaultAuthenticationSessionResolver;
`
    : '';
  const refreshStoreConst = features.refreshToken
    ? `    const refreshTokenStore = c.get('refreshTokenStore') ?? defaultRefreshTokenStore;
`
    : '';
  const grantTypeSupportedStep = features.refreshToken
    ? `    // RFC 6749 §5.2: is the grant_type offered by this OP at all?
    // (defaults to ['authorization_code', 'refresh_token'])
    const grantType = validateGrantTypeSupported(params.grant_type);
`
    : `    // The refresh_token feature is disabled: the OP only offers the
    // authorization_code grant, so refresh_token requests are rejected with
    // unsupported_grant_type (RFC 6749 §5.2).
    const grantType = validateGrantTypeSupported(params.grant_type, ['authorization_code']);
`;
  const grantValidationStep = features.refreshToken
    ? `    // Grant-specific validation. Each security rule is a separate core call so
    // it can be removed, replaced, or surrounded with experiment-specific logic.
    let validatedRequest: ValidatedTokenRequest;
    if (grantType === 'refresh_token') {
      // Resolve the presented refresh token and retain its stored grant context.
      const { refreshTokenInfo } = await resolveRefreshToken(
        params,
        refreshTokenResolver,
      );

      // OAuth 2.1 §4.3.1: reject rotation reuse and revoke the token family.
      await validateRefreshTokenUnused(refreshTokenInfo, refreshTokenResolver);

      // Bind the refresh token to the authenticated client.
      validateRefreshTokenClient(refreshTokenInfo, authenticatedClientId);

      // Absolute lifetime: expiresAt <= now is expired.
      validateRefreshTokenExpiration(refreshTokenInfo);

      // Optional inactivity policy. Replace undefined with your timeout in seconds
      // to enable it, or remove this step if your experiment has no idle lifetime.
      validateRefreshTokenIdleTimeout(refreshTokenInfo, undefined);

      // online refresh token（sessionId を持つ RT）は、束縛先のログインセッションが
      // 生きている間だけ使える。ログアウト・別ユーザーでの再ログインでセッションが
      // 消えれば invalid_grant になる。offline_access が付与された RT は sessionId を
      // 持たないため、このステップを素通りしてログアウト後も使い続けられる。
      await validateRefreshTokenSession(refreshTokenInfo, authenticationSessionResolver);

      // RFC 6749 §6: requested scope may only narrow the original grant.
      const effectiveScope = validateRefreshTokenScope(
        params.scope,
        refreshTokenInfo.scope,
      );

      validatedRequest = buildValidatedRefreshTokenRequest(
        refreshTokenInfo,
        authenticatedClientId,
        effectiveScope,
      );
    } else {
      // Resolve the presented authorization code and retain the non-optional code.
      const { code, authorizationCode } = await resolveAuthorizationCode(
        params,
        authorizationCodeResolver,
      );

      // OAuth 2.1 §4.1.2: reject reuse and revoke tokens from the compromised grant.
      await validateAuthorizationCodeUnused(
        authorizationCode,
        authorizationCodeResolver,
      );

      // Bind the authorization code to the authenticated client and its lifetime.
      validateAuthorizationCodeClient(authorizationCode, authenticatedClientId);
      validateAuthorizationCodeExpiration(authorizationCode);

      // OIDC Core 1.0 §3.1.3.2: bind the token request redirect_uri.
      validateAuthorizationCodeRedirectUri(
        authorizationCode,
        params.redirect_uri,
      );

      // RFC 7636: validate the S256 verifier when the code carries a PKCE binding.
      const codeVerified = await verifyAuthorizationCodePkce(
        authorizationCode,
        params.code_verifier,
      );

      // Mark used (do not physically delete) so a later replay remains detectable.
      await consumeAuthorizationCode(code, authorizationCodeResolver);

      validatedRequest = buildValidatedAuthorizationCodeRequest(
        code,
        authorizationCode,
        authenticatedClientId,
        codeVerified,
      );
    }
`
    : `    // Grant-specific validation (authorization_code only in this configuration).
    // Every security rule remains an independent customization point.
    const { code, authorizationCode } = await resolveAuthorizationCode(
      params,
      authorizationCodeResolver,
    );
    await validateAuthorizationCodeUnused(
      authorizationCode,
      authorizationCodeResolver,
    );
    validateAuthorizationCodeClient(authorizationCode, authenticatedClientId);
    validateAuthorizationCodeExpiration(authorizationCode);
    validateAuthorizationCodeRedirectUri(authorizationCode, params.redirect_uri);
    const codeVerified = await verifyAuthorizationCodePkce(
      authorizationCode,
      params.code_verifier,
    );
    await consumeAuthorizationCode(code, authorizationCodeResolver);
    // The cast widens the result back to the ValidatedTokenRequest union: TypeScript
    // narrows a const to its initializer type, which would make the shared downstream
    // refresh_token branches unreachable (never) even though they are still compiled.
    const validatedRequest = buildValidatedAuthorizationCodeRequest(
      code,
      authorizationCode,
      authenticatedClientId,
      codeVerified,
    ) as ValidatedTokenRequest;
`;
  const refreshGrantImport = features.refreshToken
    ? `
  resolveRefreshToken,
  validateRefreshTokenUnused,
  validateRefreshTokenClient,
  validateRefreshTokenExpiration,
  validateRefreshTokenIdleTimeout,
  validateRefreshTokenScope,
  validateRefreshTokenSession,
  clientAllowsRefreshTokenGrant,
  buildValidatedRefreshTokenRequest,`
    : '';
  const grantHasOfflineAccessBlock = features.refreshToken
    ? `    // --- Refresh Token を発行するかの判定 -------------------------------------
    //
    // RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2: grant_types の既定は
    // ["authorization_code"]。refresh_token を登録していないクライアントへ RT を渡しても、
    // 次に grant_type=refresh_token を出した瞬間 validateClientGrantType が
    // unauthorized_client で拒否する。一度も使えない長期資格情報を保存させるだけなので
    // （RFC 9700 §4.14）、登録が無ければ発行しない。
    const clientAllowsRefreshGrant = clientAllowsRefreshTokenGrant(tokenClient);

    // RFC 6749 §6 / OIDC Core 1.0 §11: refresh 時の scope 縮小は当該リクエストの access token /
    // ID Token の権限縮小として扱い、refresh token rotation の可否とは切り離す。rotation 可否は
    // 「元の grant が offline_access を持っていたか」で判断する。
    // - authorization_code grant: 今回付与された scope に offline_access があるか。
    // - refresh_token grant: 元 refresh token の grant が offline_access を持っていたか
    //   (validatedRequest.hadOfflineAccess)。縮小後 scope から offline_access を落としても
    //   元 grant の権限は失われないため rotation を継続する。
    const grantHasOfflineAccess =
      clientAllowsRefreshGrant &&
      (validatedRequest.grantType === 'refresh_token'
        ? validatedRequest.hadOfflineAccess
        : validatedRequest.scope.includes('offline_access'));

    // online refresh token の束縛先セッション。
    // OIDC Core 1.0 §11 は offline_access を「End-User が居ない（not logged in）ときにも
    // 使える Refresh Token」と定義したうえで、Refresh Token の利用がその用途に限られない
    // ことも明示している（"The Authorization Server MAY grant Refresh Tokens in other
    // contexts"）。この OP はその other contexts を online refresh token として実装し、
    // ログインセッションへ束縛する。offline_access がある grant は束縛しない。
    // - authorization_code grant: 認可コードが持つ sessionId（ログイン時に確立したもの）。
    // - refresh_token grant: 元 RT の束縛をそのまま引き継ぎ、rotation で外れないようにする。
    const boundSessionId = grantHasOfflineAccess ? undefined : validatedRequest.sessionId;

    // 束縛先が分からなければ online refresh token は発行しない。ブラウザセッションを
    // 持たない経路（device authorization grant）が該当する。ログアウトで止まる保証を
    // 付けられない RT を配らないための fail-closed。
    const issueRefreshToken =
      clientAllowsRefreshGrant &&
      (grantHasOfflineAccess ||
        (config.onlineRefreshTokenEnabled && boundSessionId !== undefined));

`
    : '';
  const refreshTokenValueExpression = features.refreshToken
    ? `issueRefreshToken ? generateRandomString(32) : undefined`
    : `undefined /* the refresh_token feature is disabled: never issue one */`;
  // generateRandomString only mints refresh token values, so the import must shrink
  // with the feature to keep noUnusedLocals green.
  const randomStringImport = features.refreshToken
    ? `
  generateRandomString,`
    : '';
  const refreshTokenPersistenceBlock = features.refreshToken
    ? `    // Store the new refresh token for rotation (OAuth 2.1 Section 4.3.1).
    // The same grantId / audience / authTime / nonce / acr / amr / azp is propagated through
    // rotations so descendants can be revoked on code reuse, the audience never expands,
    // and refresh で再発行する ID Token は OIDC Core 1.0 §12.1 に従い初回認証時の値を保持する。
    if (tokenResponse.refresh_token) {
      // authTime はここで必ず確定する: authorization_code 経由は authCode.authTime、
      // refresh_token 経由は validatedRequest.authTime（前段で代入済み）。
      const rtAuthTime = authTime;
      if (rtAuthTime === undefined) {
        throw new TokenError(
          TokenErrorCode.InvalidGrant,
          'authTime is required to issue a refresh token',
        );
      }
      // OAuth 2.1 §6.1: refresh token は initial issuance からの absolute lifetime のみで失効する。
      // rotation を跨いで originalIssuedAt を引き継ぎ、expiresAt はそこからの絶対的な期限で固定する。
      // sliding expiry は持たないため、リフレッシュを繰り返しても失効時刻は前に進まず、
      // 漏洩 RT の長期 abuse を防ぐ。
      // - authorization_code grant: 今回が初回発行なので originalIssuedAt = issuedAt。
      // - refresh_token grant: 元 RT の originalIssuedAt をそのまま引き継ぐ。
      const originalIssuedAt =
        validatedRequest.grantType === 'refresh_token'
          ? validatedRequest.originalIssuedAt
          : issuedAt;
      const refreshTokenExpiresAt = originalIssuedAt + config.refreshTokenAbsoluteLifetime;
      // RFC 6749 §6: 縮小後 scope（validatedRequest.scope）から offline_access が落ちても、
      // grant が offline_access を持つ限り次回以降の rotation を継続できるよう、永続化する
      // refresh token の scope には offline_access を保持する。access token は
      // validatedRequest.scope をそのまま使うため、当該リクエストの権限は縮小されたままになる。
      const refreshTokenScope =
        grantHasOfflineAccess && !validatedRequest.scope.includes('offline_access')
          ? [...validatedRequest.scope, 'offline_access']
          : validatedRequest.scope;
      await refreshTokenStore.set(tokenResponse.refresh_token, {
        subject,
        clientId: validatedRequest.clientId,
        scope: refreshTokenScope,
        expiresAt: refreshTokenExpiresAt,
        originalIssuedAt,
        used: false,
        grantId: validatedRequest.grantId,
        iat: issuedAt,
        issuer: config.issuer,
        audience: effectiveAudience,
        authTime: rtAuthTime,
        nonce,
        // OIDC Core 1.0 §12.1: refresh で再発行する ID Token は初回認証時の acr / amr を保持する。
        // - authorization_code grant: 直前で resolver が解決した値をそのまま永続化する。
        // - refresh_token grant: 既に保存済みの値を引き継ぐ（resolver は呼ばれていない）。
        acr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.acr : resolvedAcr,
        amr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.amr : resolvedAmr,
        azp: validatedRequest.grantType === 'refresh_token' ? validatedRequest.azp : undefined,
        // online refresh token の束縛。undefined なら offline refresh token として
        // セッションから独立し、ログアウト後も使える。
        sessionId: boundSessionId,
      });
    }

    // OAuth 2.1 Section 4.3.1: ローテーションは新トークン保存成功後に旧 RT を失効する。
    // 失敗時にユーザーがリフレッシュ不能になることを防ぐため、必ずこの順序にする。
    if (validatedRequest.grantType === 'refresh_token' && params.refresh_token) {
      await refreshTokenResolver.revokeRefreshToken(params.refresh_token);
    }

`
    : '';

  // EXPERIMENTAL (RFC 8693): dispatch the token-exchange grant before core's
  // validateGrantTypeSupported rejects the URN. Every interpolation below
  // collapses to the current output when the token-exchange feature is off, so
  // the default generation is unchanged byte for byte.
  const tokenExchangeResolverImport = features.tokenExchange
    ? `
  accessTokenResolver as defaultAccessTokenResolver,`
    : '';
  const tokenExchangeImports = features.tokenExchange
    ? `
import {
  TOKEN_EXCHANGE_GRANT_TYPE,
  TokenExchangeError,
  buildTokenExchangeResponse,
  processTokenExchangeRequest,
  type ExchangedAccessTokenInfo,
} from '${EXPERIMENTAL_PACKAGE}/token-exchange';`
    : '';
  const tokenExchangeConfigBlock = features.tokenExchange
    ? `
/**
 * EXPERIMENTAL — OAuth 2.0 Token Exchange settings (RFC 8693).
 *
 * - allowedTargets: the audience / resource values a client may ask an
 *   exchanged token to be issued for. Empty by default (fail safe): with an
 *   empty list every exchange that names a target is rejected with
 *   invalid_target, and only scope-narrowing / lifetime-shortening exchanges
 *   succeed. Add the identifiers of your downstream services here.
 */
export const tokenExchangeConfig = {
  allowedTargets: [] as string[],
};
`
    : '';
  const tokenExchangeDispatchStep = features.tokenExchange
    ? `
    // --- EXPERIMENTAL: OAuth 2.0 Token Exchange (RFC 8693 §2.1) ------------
    // Dispatched right after client authentication and BEFORE core's
    // validateGrantTypeSupported, which does not know the URN and would reject
    // it with unsupported_grant_type. The branch answers the request itself and
    // never falls through to the standard grants.
    //
    // Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may change
    // in a breaking way between releases. Do not build production code on it
    // without pinning the version.
    //
    // Known limitation: RFC 8693 §2.1 permits repeated \`resource\` / \`audience\`
    // parameters, but this endpoint rejects any repeated parameter (RFC 6749
    // §3.2), so only a single value of each is supported.
    if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE) {
      const accessTokenResolver = c.get('accessTokenResolver') ?? defaultAccessTokenResolver;
      // config and the signing key are bound further down for the standard
      // grants. This branch reads them on its own so the generated output is
      // unchanged when the feature is off; it returns, so nothing runs twice.
      const exchangeConfig = c.get('config');
      // The first registered key signs new tokens (SigningKeyProvider contract).
      const exchangeSigningKey: SigningKey = c.get('signingKeys')[0];
      const exchangeIssuer: AccessTokenIssuer =
        exchangeConfig.accessTokenFormat === 'opaque'
          ? createOpaqueAccessTokenIssuer()
          : createJwtAccessTokenIssuer();

      // Validate the request and derive the issuing material. Each check inside
      // is also exported as its own step function, so you can call them one by
      // one instead and drop or replace individual rules.
      const grant = await processTokenExchangeRequest({
        params,
        client: tokenClient,
        accessTokenResolver,
        allowedTargets: tokenExchangeConfig.allowedTargets,
        configuredExpiresIn: exchangeConfig.accessTokenExpiresIn,
      });

      // Same aud policy as the standard token route: the UserInfo endpoint stays
      // a permanent member (RFC 9068 §3), so an exchanged token still passes the
      // UserInfo endpoint's audience check.
      const exchangeAudience = buildAccessTokenAudience({
        userInfoEndpoint: \`\${exchangeConfig.issuer}/userinfo\`,
        requested: grant.requestedAudience,
        issuer: exchangeConfig.issuer,
      });

      const exchangeIssuedAt = Math.floor(Date.now() / 1000);
      const exchangePayload = buildAccessTokenPayload({
        issuer: exchangeConfig.issuer,
        subject: grant.subject,
        clientId: grant.clientId,
        scope: grant.scope,
        audience: exchangeAudience,
        expiresIn: grant.expiresIn,
        issuedAt: exchangeIssuedAt,
      });
      const exchangedToken = await exchangeIssuer.issue({
        payload: {
          ...exchangePayload,
          // RFC 8693 §4.1: a delegation exchange records the current actor in
          // the act claim (chains already nested by processTokenExchangeRequest).
          // Impersonation exchanges carry no act claim.
          ...(grant.actor === undefined ? {} : { act: grant.actor }),
        },
        privateKey: exchangeSigningKey.privateKey,
        keyId: exchangeSigningKey.keyId,
      });

      const exchangeMetadata: ExchangedAccessTokenInfo = {
        // RFC 8693 §1.1: the exchanged token acts as the same subject, but is
        // bound to the client that requested the exchange.
        sub: grant.subject,
        clientId: grant.clientId,
        scope: grant.scope,
        expiresAt: exchangeIssuedAt + grant.expiresIn,
        // Inherit the subject token's grant so revoking the grant (e.g. on code
        // reuse detection) also kills every token exchanged from it.
        grantId: grant.grantId,
        iat: exchangeIssuedAt,
        nbf: exchangeIssuedAt,
        audience: exchangeAudience,
        issuer: exchangeConfig.issuer,
        // RFC 9068 §2.2 / RFC 7662 §2.2: the exchanged token gets its own jti,
        // so it is a distinct store record even when it is exchanged twice from
        // the same subject_token within one second.
        jti: exchangePayload.jti,
        // Persisting act lets a later exchange that presents THIS token as its
        // subject_token pick up the chain (RFC 8693 §4.1 nesting).
        ...(grant.actor === undefined ? {} : { act: grant.actor }),
        // The subject token's stored claims parameter (OIDC Core 1.0 §5.5) is
        // deliberately NOT inherited: an exchanged token yields scope-based
        // claims only at the UserInfo endpoint.
      };
      await accessTokenStore.set(exchangedToken, exchangeMetadata);

      // RFC 6749 §5.1: token responses MUST NOT be cached.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      // RFC 8693 §2.2.1: access_token / issued_token_type / token_type are
      // REQUIRED; expires_in and scope are always included here.
      return c.json(buildTokenExchangeResponse({
        accessToken: exchangedToken,
        expiresIn: grant.expiresIn,
        scope: grant.scope,
      }));
    }
`
    : '';
  // EXPERIMENTAL (RFC 8628 §3.4): dispatch the device_code grant before core's
  // validateGrantTypeSupported rejects the URN. Every interpolation below
  // collapses to the current output when the feature is off, so the default
  // generation is unchanged byte for byte.
  const deviceGrantImports = features.deviceAuthorizationGrant
    ? `
import {
  DEVICE_CODE_GRANT_TYPE,
  DeviceAuthorizationError,
  processDeviceCodeGrant,
} from '${EXPERIMENTAL_PACKAGE}/device-authorization-grant';
import { deviceAuthorizationStore as defaultDeviceAuthorizationStore } from '../store.js';`
    : '';
  // The device grant issues a refresh token under exactly the conditions the
  // standard grants do, so the block only exists when refresh tokens do.
  const deviceRefreshTokenBlock =
    features.deviceAuthorizationGrant && features.refreshToken
      ? `
      // OIDC Core 1.0 §11: offline_access survived the device authorization
      // endpoint's policy check only if this client may hold refresh tokens, and
      // the approval screen the user just went through IS the explicit consent
      // that §11 asks for. Nothing further to gate on here.
      const deviceRefreshToken = deviceGrant.scope.includes('offline_access')
        ? generateRandomString(32)
        : undefined;
      if (deviceRefreshToken) {
        const deviceRefreshTokenStore = c.get('refreshTokenStore') ?? defaultRefreshTokenStore;
        await deviceRefreshTokenStore.set(deviceRefreshToken, {
          subject: deviceGrant.subject,
          clientId: deviceGrant.clientId,
          scope: deviceGrant.scope,
          // OAuth 2.1 §6.1: absolute lifetime from initial issuance; rotations
          // inherit originalIssuedAt so the deadline never slides forward.
          expiresAt: deviceIssuedAt + deviceConfig.refreshTokenAbsoluteLifetime,
          originalIssuedAt: deviceIssuedAt,
          used: false,
          grantId: deviceGrant.grantId,
          iat: deviceIssuedAt,
          issuer: deviceConfig.issuer,
          audience: deviceAudience,
          authTime: deviceGrant.authTime,
          // RFC 8628 has no nonce parameter, so the re-issued ID Token has none
          // to preserve either.
          nonce: undefined,
          acr: deviceAcr,
          amr: deviceAmr,
          azp: undefined,
        });
      }
`
      : '';
  const deviceRefreshTokenField =
    features.deviceAuthorizationGrant && features.refreshToken
      ? `
        refresh_token: deviceRefreshToken,`
      : '';
  const deviceCodeDispatchStep = features.deviceAuthorizationGrant
    ? `
    // --- EXPERIMENTAL: OAuth 2.0 Device Authorization Grant (RFC 8628 §3.4) ---
    // Dispatched right after client authentication and BEFORE core's
    // validateGrantTypeSupported, which does not know the URN and would reject it
    // with unsupported_grant_type. The branch answers the request itself and
    // never falls through to the standard grants.
    //
    // Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may change
    // in a breaking way between releases. Do not build production code on it
    // without pinning the version.
    if (params.grant_type === DEVICE_CODE_GRANT_TYPE) {
      const deviceStore = c.get('deviceAuthorizationStore') ?? defaultDeviceAuthorizationStore;

      // RFC 8628 §3.5 state machine. Everything except "approved" throws:
      // authorization_pending / slow_down / access_denied / expired_token, plus
      // invalid_request / invalid_grant / unauthorized_client from §3.4.
      const deviceGrant = await processDeviceCodeGrant({
        params,
        client: tokenClient,
        store: deviceStore,
      });

      // config and the signing keys are bound further down for the standard
      // grants. This branch reads them on its own so the generated output is
      // unchanged when the feature is off; it returns, so nothing runs twice.
      const deviceConfig = c.get('config');
      // The first registered key signs new tokens (SigningKeyProvider contract).
      const deviceSigningKey: SigningKey = c.get('signingKeys')[0];
      const devicePrivateKey = deviceSigningKey.privateKey;
      const deviceKeyId = deviceSigningKey.keyId;
      // T-022: the ID Token this grant issues follows the SAME key-selection rule
      // as the standard grants — pick a registered ID Token key whose alg matches
      // the client's id_token_signed_response_alg (OIDC Dynamic Client
      // Registration 1.0 §2), not simply the first key of the set. Using the
      // first key would hand an ES256-registered client an RS256 ID Token, which
      // it rejects, and would hash at_hash with the wrong algorithm.
      const deviceIdTokenSigningKeys = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
      const deviceRegisteredClient = (await tokenClientResolver.findClient(
        authenticatedClientId,
      )) as RegisteredClient | null;
      const deviceRequestedIdTokenAlg = deviceRegisteredClient?.idTokenSignedResponseAlg;
      let deviceSelectedIdTokenKey: SigningKey;
      try {
        deviceSelectedIdTokenKey = selectSigningKeyByAlg(deviceIdTokenSigningKeys, deviceRequestedIdTokenAlg);
      } catch {
        c.header('Cache-Control', 'no-store');
        c.header('Pragma', 'no-cache');
        return c.json(
          {
            error: 'server_error',
            error_description: \`No ID Token signing key registered for alg "\${deviceRequestedIdTokenAlg ?? 'RS256'}"\`,
          },
          500,
        );
      }
      const deviceIdTokenPrivateKey = deviceSelectedIdTokenKey.privateKey;
      const deviceIdTokenKeyId = deviceSelectedIdTokenKey.keyId;
      const deviceIssuer: AccessTokenIssuer =
        deviceConfig.accessTokenFormat === 'opaque'
          ? createOpaqueAccessTokenIssuer()
          : createJwtAccessTokenIssuer();

      // Same aud policy as the standard token route: the UserInfo endpoint stays
      // a permanent member (RFC 9068 §3). RFC 8628 has no resource parameter, so
      // nothing else is requested.
      const deviceAudience = buildAccessTokenAudience({
        userInfoEndpoint: \`\${deviceConfig.issuer}/userinfo\`,
        issuer: deviceConfig.issuer,
      });

      const deviceIssuedAt = Math.floor(Date.now() / 1000);
      const deviceAccessTokenPayload = buildAccessTokenPayload({
        issuer: deviceConfig.issuer,
        subject: deviceGrant.subject,
        clientId: deviceGrant.clientId,
        scope: deviceGrant.scope,
        audience: deviceAudience,
        expiresIn: deviceConfig.accessTokenExpiresIn,
        issuedAt: deviceIssuedAt,
      });
      const deviceAccessToken = await deviceIssuer.issue({
        payload: deviceAccessTokenPayload,
        privateKey: devicePrivateKey,
        keyId: deviceKeyId,
      });

      // The device authorization endpoint requires the openid scope, so an ID
      // Token is always issued. It carries no nonce (RFC 8628 defines no such
      // parameter, and OIDC Core 1.0 §2 only requires nonce when the
      // authentication request carried one) and no c_hash (there is no code).
      const deviceAtHash = await computeAtHash(deviceAccessToken, deviceIdTokenPrivateKey);
      const deviceAcrResolver = c.get('acrResolver') as AcrResolver | undefined;
      const { acr: deviceAcr, amr: deviceAmr } = await resolveAcrAmr({
        subject: deviceGrant.subject,
        clientId: deviceGrant.clientId,
        acrResolver: deviceAcrResolver,
      });
      const deviceIdTokenPayload = buildIdTokenPayload({
        issuer: deviceConfig.issuer,
        subject: deviceGrant.subject,
        clientId: deviceGrant.clientId,
        scope: deviceGrant.scope,
        expiresIn: deviceConfig.idTokenExpiresIn,
        issuedAt: deviceIssuedAt,
        atHash: deviceAtHash,
        authTime: deviceGrant.authTime,
        acr: deviceAcr,
        amr: deviceAmr,
      });
      const deviceIdToken = await generateIdToken({
        payload: deviceIdTokenPayload,
        privateKey: deviceIdTokenPrivateKey,
        keyId: deviceIdTokenKeyId,
      });

      await accessTokenStore.set(deviceAccessToken, {
        sub: deviceGrant.subject,
        clientId: deviceGrant.clientId,
        scope: deviceGrant.scope,
        expiresAt: deviceIssuedAt + deviceConfig.accessTokenExpiresIn,
        // Inherit the grantId minted at approval so revoking the grant kills
        // every token issued from this device authorization.
        grantId: deviceGrant.grantId,
        iat: deviceIssuedAt,
        nbf: deviceIssuedAt,
        audience: deviceAudience,
        issuer: deviceConfig.issuer,
        jti: deviceAccessTokenPayload.jti,
      });
${deviceRefreshTokenBlock}
      // RFC 6749 §5.1: token responses MUST NOT be cached.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json({
        access_token: deviceAccessToken,
        token_type: 'Bearer' as const,
        expires_in: deviceConfig.accessTokenExpiresIn,
        id_token: deviceIdToken,
        scope: deviceGrant.scope.join(' '),${deviceRefreshTokenField}
      });
    }
`
    : '';
  // EXPERIMENTAL (CIBA Core 1.0 §10.1): dispatch the CIBA grant before core's
  // validateGrantTypeSupported rejects the URN. Every interpolation below
  // collapses to the current output when the feature is off, so the default
  // generation is unchanged byte for byte.
  const cibaGrantImports = features.ciba
    ? `
import {
  CIBA_GRANT_TYPE,
  CibaGrantError,
  processCibaGrant,
} from '${EXPERIMENTAL_PACKAGE}/ciba';
import { cibaAuthenticationRequestStore as defaultCibaAuthenticationRequestStore } from '../store.js';`
    : '';
  // The CIBA grant issues a refresh token under exactly the conditions the
  // standard grants do, so the block only exists when refresh tokens do.
  const cibaRefreshTokenBlock =
    features.ciba && features.refreshToken
      ? `
      // OIDC Core 1.0 §11: offline_access survived the backchannel
      // authentication endpoint's policy check only if this client may hold
      // refresh tokens, and the approval screen the user just went through IS
      // the explicit consent that §11 asks for. Nothing further to gate on here.
      const cibaRefreshToken = cibaGrant.scope.includes('offline_access')
        ? generateRandomString(32)
        : undefined;
      if (cibaRefreshToken) {
        const cibaRefreshTokenStore = c.get('refreshTokenStore') ?? defaultRefreshTokenStore;
        await cibaRefreshTokenStore.set(cibaRefreshToken, {
          subject: cibaGrant.subject,
          clientId: cibaGrant.clientId,
          scope: cibaGrant.scope,
          // OAuth 2.1 §6.1: absolute lifetime from initial issuance; rotations
          // inherit originalIssuedAt so the deadline never slides forward.
          expiresAt: cibaIssuedAt + cibaTokenConfig.refreshTokenAbsoluteLifetime,
          originalIssuedAt: cibaIssuedAt,
          used: false,
          grantId: cibaGrant.grantId,
          iat: cibaIssuedAt,
          issuer: cibaTokenConfig.issuer,
          audience: cibaAudience,
          authTime: cibaGrant.authTime,
          // CIBA §7.1 defines no nonce parameter, so the re-issued ID Token has
          // none to preserve either.
          nonce: undefined,
          acr: cibaAcr,
          amr: cibaAmr,
          azp: undefined,
        });
      }
`
      : '';
  const cibaRefreshTokenField =
    features.ciba && features.refreshToken
      ? `
        refresh_token: cibaRefreshToken,`
      : '';
  const cibaDispatchStep = features.ciba
    ? `
    // --- EXPERIMENTAL: CIBA grant (CIBA Core 1.0 §10.1, poll mode) ----------
    // Dispatched right after client authentication and BEFORE core's
    // validateGrantTypeSupported, which does not know the URN and would reject
    // it with unsupported_grant_type. The branch answers the request itself and
    // never falls through to the standard grants.
    //
    // Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may change
    // in a breaking way between releases. Do not build production code on it
    // without pinning the version.
    if (params.grant_type === CIBA_GRANT_TYPE) {
      const cibaStore = c.get('cibaAuthenticationRequestStore') ?? defaultCibaAuthenticationRequestStore;

      // CIBA §11 state machine. Everything except "approved" throws:
      // authorization_pending / slow_down / access_denied / expired_token, plus
      // invalid_request / invalid_grant.
      const cibaGrant = await processCibaGrant({
        params,
        client: tokenClient,
        store: cibaStore,
      });

      // config and the signing keys are bound further down for the standard
      // grants. This branch reads them on its own so the generated output is
      // unchanged when the feature is off; it returns, so nothing runs twice.
      const cibaTokenConfig = c.get('config');
      // The first registered key signs new tokens (SigningKeyProvider contract).
      const cibaSigningKey: SigningKey = c.get('signingKeys')[0];
      const cibaPrivateKey = cibaSigningKey.privateKey;
      const cibaKeyId = cibaSigningKey.keyId;
      // T-022: the ID Token this grant issues follows the SAME key-selection rule
      // as the standard grants — pick a registered ID Token key whose alg matches
      // the client's id_token_signed_response_alg (OIDC Dynamic Client
      // Registration 1.0 §2), not simply the first key of the set. Using the
      // first key would hand an ES256-registered client an RS256 ID Token, which
      // it rejects, and would hash at_hash with the wrong algorithm.
      const cibaIdTokenSigningKeys = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
      const cibaRegisteredClient = (await tokenClientResolver.findClient(
        authenticatedClientId,
      )) as RegisteredClient | null;
      const cibaRequestedIdTokenAlg = cibaRegisteredClient?.idTokenSignedResponseAlg;
      let cibaSelectedIdTokenKey: SigningKey;
      try {
        cibaSelectedIdTokenKey = selectSigningKeyByAlg(cibaIdTokenSigningKeys, cibaRequestedIdTokenAlg);
      } catch {
        c.header('Cache-Control', 'no-store');
        c.header('Pragma', 'no-cache');
        return c.json(
          {
            error: 'server_error',
            error_description: \`No ID Token signing key registered for alg "\${cibaRequestedIdTokenAlg ?? 'RS256'}"\`,
          },
          500,
        );
      }
      const cibaIdTokenPrivateKey = cibaSelectedIdTokenKey.privateKey;
      const cibaIdTokenKeyId = cibaSelectedIdTokenKey.keyId;
      const cibaIssuer: AccessTokenIssuer =
        cibaTokenConfig.accessTokenFormat === 'opaque'
          ? createOpaqueAccessTokenIssuer()
          : createJwtAccessTokenIssuer();

      // Same aud policy as the standard token route: the UserInfo endpoint stays
      // a permanent member (RFC 9068 §3). CIBA §7.1 has no resource parameter,
      // so nothing else is requested.
      const cibaAudience = buildAccessTokenAudience({
        userInfoEndpoint: \`\${cibaTokenConfig.issuer}/userinfo\`,
        issuer: cibaTokenConfig.issuer,
      });

      const cibaIssuedAt = Math.floor(Date.now() / 1000);
      const cibaAccessTokenPayload = buildAccessTokenPayload({
        issuer: cibaTokenConfig.issuer,
        subject: cibaGrant.subject,
        clientId: cibaGrant.clientId,
        scope: cibaGrant.scope,
        audience: cibaAudience,
        expiresIn: cibaTokenConfig.accessTokenExpiresIn,
        issuedAt: cibaIssuedAt,
      });
      const cibaAccessToken = await cibaIssuer.issue({
        payload: cibaAccessTokenPayload,
        privateKey: cibaPrivateKey,
        keyId: cibaKeyId,
      });

      // The backchannel authentication endpoint requires the openid scope, so
      // an ID Token is always issued. It carries no nonce (CIBA §7.1 defines no
      // such parameter, and OIDC Core 1.0 §2 only requires nonce when the
      // authentication request carried one) and no c_hash (there is no code).
      // Poll mode adds no CIBA-specific claims either — the auth_req_id claim
      // of §10.3.1 belongs to the push-mode token delivery message.
      const cibaAtHash = await computeAtHash(cibaAccessToken, cibaIdTokenPrivateKey);
      const cibaAcrResolver = c.get('acrResolver') as AcrResolver | undefined;
      const { acr: cibaAcr, amr: cibaAmr } = await resolveAcrAmr({
        subject: cibaGrant.subject,
        clientId: cibaGrant.clientId,
        acrResolver: cibaAcrResolver,
      });
      const cibaIdTokenPayload = buildIdTokenPayload({
        issuer: cibaTokenConfig.issuer,
        subject: cibaGrant.subject,
        clientId: cibaGrant.clientId,
        scope: cibaGrant.scope,
        expiresIn: cibaTokenConfig.idTokenExpiresIn,
        issuedAt: cibaIssuedAt,
        atHash: cibaAtHash,
        authTime: cibaGrant.authTime,
        acr: cibaAcr,
        amr: cibaAmr,
      });
      const cibaIdToken = await generateIdToken({
        payload: cibaIdTokenPayload,
        privateKey: cibaIdTokenPrivateKey,
        keyId: cibaIdTokenKeyId,
      });

      await accessTokenStore.set(cibaAccessToken, {
        sub: cibaGrant.subject,
        clientId: cibaGrant.clientId,
        scope: cibaGrant.scope,
        expiresAt: cibaIssuedAt + cibaTokenConfig.accessTokenExpiresIn,
        // Inherit the grantId minted at approval so revoking the grant kills
        // every token issued from this backchannel authentication.
        grantId: cibaGrant.grantId,
        iat: cibaIssuedAt,
        nbf: cibaIssuedAt,
        audience: cibaAudience,
        issuer: cibaTokenConfig.issuer,
        jti: cibaAccessTokenPayload.jti,
      });
${cibaRefreshTokenBlock}
      // RFC 6749 §5.1: token responses MUST NOT be cached.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json({
        access_token: cibaAccessToken,
        token_type: 'Bearer' as const,
        expires_in: cibaTokenConfig.accessTokenExpiresIn,
        id_token: cibaIdToken,
        scope: cibaGrant.scope.join(' '),${cibaRefreshTokenField}
      });
    }
`
    : '';
  const cibaGrantCatchBranch = features.ciba
    ? `    if (error instanceof CibaGrantError) {
      // CIBA §11: authorization_pending / slow_down / access_denied /
      // expired_token use the RFC 6749 §5.2 shape and are always 400. A 401 can
      // only come from client authentication, which runs before the branch and
      // throws core's TokenError.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        { error: error.code, error_description: error.errorDescription },
        error.statusCode,
      );
    }
`
    : '';
  const deviceGrantCatchBranch = features.deviceAuthorizationGrant
    ? `    if (error instanceof DeviceAuthorizationError) {
      // RFC 8628 §3.5: authorization_pending / slow_down / access_denied /
      // expired_token use the RFC 6749 §5.2 shape and are always 400. A 401 can
      // only come from client authentication, which runs before the branch and
      // throws core's TokenError.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        { error: error.code, error_description: error.errorDescription },
        error.statusCode,
      );
    }
`
    : '';
  const tokenExchangeCatchBranch = features.tokenExchange
    ? `    if (error instanceof TokenExchangeError) {
      // RFC 8693 §2.2.2: the exchange errors use the RFC 6749 §5.2 shape. They
      // are always 400 — a 401 can only come from client authentication, which
      // runs before the branch and throws core's TokenError.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        { error: error.code, error_description: error.errorDescription },
        error.statusCode,
      );
    }
`
    : '';

  // EXPERIMENTAL (ID-JAG draft §4.3 / §4.4): Cross-App Access. Two extra grant
  // branches — ID-JAG issuance inside the token-exchange grant, and ID-JAG
  // redemption as the jwt-bearer grant. Every interpolation below collapses to
  // the current output when the id-jag feature is off, so the default
  // generation is unchanged byte for byte.
  //
  // When both id-jag and token-exchange are enabled, the issuance branch must
  // run BEFORE the token-exchange branch: both share the grant_type URN and are
  // told apart by requested_token_type. Only when token-exchange is off does the
  // issuance step also answer the remaining token-exchange requests (with a
  // pointer to the single requested_token_type this build supports), so the
  // discovery advertisement of the exchange grant never dead-ends in
  // unsupported_grant_type.
  const idJagTokenExchangeConstImport =
    features.idJag && !features.tokenExchange
      ? `
  ID_JAG_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,`
      : '';
  const idJagImports = features.idJag
    ? `
import {
  IdJagError,
  JWT_BEARER_GRANT_TYPE,${idJagTokenExchangeConstImport}
  TOKEN_TYPE_ID_TOKEN,
  matchesIdJagIssuanceRequest,
  processIdJagIssuanceRequest,
  processIdJagRedemptionRequest,
  resolveIdJagActor,
  type IdJagAccessTokenInfo,
  type IdJagActorTokenResolver,
  type IdJagTrustedIdentityProvider,
} from '${EXPERIMENTAL_PACKAGE}/id-jag';
import type { JwkSet } from '${corePkg}';`
    : '';
  // draft §4.3 MAY: refresh-token subjects only exist when the generated OP
  // issues refresh tokens at all, so the knob and the resolver hand-off are
  // emitted under the refresh-token feature.
  const idJagRefreshConfigDoc =
    features.idJag && features.refreshToken
      ? `
 * - allowRefreshTokenSubjects: whether a refresh token this OP issued may stand
 *   in for the ID Token as the subject_token (draft §4.3 MAY), so a client can
 *   request a fresh ID-JAG after its ID Token expired without a new SSO round
 *   trip. Validated exactly like the standard refresh_token grant (rotation
 *   reuse revokes the token family; online tokens require the login session to
 *   be alive); the refresh token is NOT consumed. Grants without the openid
 *   scope are refused — their refresh token replaces no identity assertion.`
      : '';
  const idJagRefreshConfigField =
    features.idJag && features.refreshToken
      ? `
  allowRefreshTokenSubjects: true,`
      : '';
  const idJagConfigBlock = features.idJag
    ? `
/**
 * EXPERIMENTAL — Cross-App Access (XAA) / ID-JAG settings
 * (draft-ietf-oauth-identity-assertion-authz-grant-04).
 *
 * Issuing side (this OP as the IdP, draft §4.3):
 * - allowedAudiences: resource authorization server issuers this IdP may issue
 *   an ID-JAG for. Empty by default (fail safe): every issuance request is
 *   rejected with invalid_target until you list the peer AS issuers here.
 *   Adding an entry grants that cross-app connection on behalf of every user —
 *   there is no per-user consent screen in this flow.
 * - idJagLifetimeSeconds: ID-JAG lifetime. Keep it short (draft example: 300);
 *   clients are expected to request a fresh one instead of holding it.
 * - allowedScopes: optional cap on the scopes an ID-JAG may carry. undefined
 *   passes the requested scopes through (the resource AS applies its own
 *   policy again on redemption).${idJagRefreshConfigDoc}
 * - allowActorTokens: whether an actor_token (identifying who acts on the
 *   subject's behalf) is accepted and recorded as the ID-JAG's act claim
 *   (RFC 8693 §4.1). The draft defines no normative actor processing (§9.7
 *   sketches extensions), so this is an opt-in extension and defaults to
 *   false — an actor_token is rejected until you flip it, whatever else is
 *   configured. Every token type identifier RFC 8693 §3 defines is accepted
 *   the same way; the type alone decides nothing.
 * - actorTokenResolver: validates the actor_token's CONTENT (signature,
 *   revocation, whose token it is) — for every accepted type, this OP's own
 *   ID Tokens included. The library only checks the request structure and the
 *   shape of what you return. Return the act value ({ sub, act? }) for a valid
 *   token, null for an invalid one (answered with a fixed invalid_request), or
 *   throw IdJagError to pick the response yourself. The default below handles
 *   ID Tokens this OP issued to the authenticated client; extend or replace it
 *   to cover the other types. Clearing it rejects every actor_token.
 *
 * Consuming side (this OP as the resource authorization server, draft §4.4):
 * - trustedIdentityProviders: the IdPs whose ID-JAGs are accepted on the
 *   jwt-bearer grant. Empty by default (fail safe). Keys come from the inline
 *   \`jwks\` when present, otherwise from \`jwksUri\` (fetched and cached below).
 *   Never derive the key source from the assertion itself.
 */
const defaultIdJagActorTokenResolver: IdJagActorTokenResolver = async ({
  actorToken,
  actorTokenType,
  clientId,
  issuer,
  jwks,
}) =>
  actorTokenType === TOKEN_TYPE_ID_TOKEN
    ? resolveIdJagActor({ actorToken, issuer, clientId, jwks })
    : null;

export const idJagConfig = {
  allowedAudiences: [] as string[],
  idJagLifetimeSeconds: 300,
  allowedScopes: undefined as string[] | undefined,${idJagRefreshConfigField}
  allowActorTokens: false,
  actorTokenResolver: defaultIdJagActorTokenResolver as IdJagActorTokenResolver | undefined,
  trustedIdentityProviders: [] as Array<{ issuer: string; jwksUri?: string; jwks?: JwkSet }>,
};

/**
 * EXPERIMENTAL — jwks_uri cache for trusted identity providers.
 *
 * A fetched JWKS is reused for 300 seconds, so a signing-key rotation at the
 * IdP can take up to that long to be picked up (a verification that fails
 * within the window is answered as an untrusted assertion). The fetch target
 * comes exclusively from the static idJagConfig above — never from request or
 * assertion content — which is what keeps this endpoint SSRF-free.
 */
const idJagJwksCache = new Map<string, { jwks: JwkSet; expiresAt: number }>();
const ID_JAG_JWKS_CACHE_TTL_MS = 300_000;

async function resolveTrustedIdentityProviders(): Promise<IdJagTrustedIdentityProvider[]> {
  const resolved: IdJagTrustedIdentityProvider[] = [];
  for (const entry of idJagConfig.trustedIdentityProviders) {
    if (entry.jwks !== undefined) {
      resolved.push({ issuer: entry.issuer, jwks: entry.jwks });
      continue;
    }
    if (entry.jwksUri === undefined) {
      // An entry with neither jwks nor jwksUri can never verify anything; skip
      // it so the assertion is answered with the fixed untrusted description.
      continue;
    }
    const cached = idJagJwksCache.get(entry.jwksUri);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      resolved.push({ issuer: entry.issuer, jwks: cached.jwks });
      continue;
    }
    // A failed fetch propagates: the generic catch turns it into server_error,
    // which is honest — the assertion was never evaluated, so invalid_grant
    // would wrongly blame the client for an outage on this side.
    const response = await fetch(entry.jwksUri);
    if (!response.ok) {
      throw new Error(\`Fetching the JWKS of trusted IdP \${entry.issuer} failed with status \${response.status}\`);
    }
    const jwks = (await response.json()) as JwkSet;
    idJagJwksCache.set(entry.jwksUri, { jwks, expiresAt: Date.now() + ID_JAG_JWKS_CACHE_TTL_MS });
    resolved.push({ issuer: entry.issuer, jwks });
  }
  return resolved;
}
`
    : '';
  // draft §4.3 MAY: refresh-token subjects hand the SAME resolvers to the
  // module that the standard refresh grant uses, so rotation-reuse revocation,
  // client binding, expiry and online-session liveness behave identically. The
  // consts referenced here are the ones the refresh grant declares above the
  // dispatch, so this collapses to nothing when refresh tokens are off.
  const idJagRefreshSubjectArgs =
    features.idJag && features.refreshToken
      ? `
        ...(idJagConfig.allowRefreshTokenSubjects
          ? { refreshTokenResolver, authenticationSessionResolver }
          : {}),`
      : '';
  const idJagTokenExchangeFallbackStep =
    features.idJag && !features.tokenExchange
      ? `
    // Generated without --enable token-exchange: the exchange grant exists here
    // only to issue ID-JAGs, so any other requested_token_type is answered with
    // a pointer instead of falling through to unsupported_grant_type (discovery
    // does advertise the exchange grant in this build).
    if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE) {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: 'invalid_request',
          error_description: \`This authorization server only supports requested_token_type \${ID_JAG_TOKEN_TYPE} for token exchange\`,
        },
        400,
      );
    }
`
      : '';
  const idJagIssuanceDispatchStep = features.idJag
    ? `
    // --- EXPERIMENTAL: ID-JAG issuance (Cross-App Access, draft §4.3) ------
    // A token-exchange request whose requested_token_type is the ID-JAG URN.
    // Dispatched right after client authentication and BEFORE the plain
    // token-exchange branch (same grant_type URN) and core's
    // validateGrantTypeSupported. The subject_token must be an ID Token this OP
    // issued to the authenticated client; the result is a signed grant JWT for
    // the resource authorization server named by \`audience\` — not an access
    // token (the response carries token_type N_A).
    //
    // Backed by ${EXPERIMENTAL_PACKAGE}, whose API is NOT stable: it may change
    // in a breaking way between releases. The underlying specification is an
    // IETF draft (-04) and may itself change. Do not build production code on
    // this without pinning versions.
    if (matchesIdJagIssuanceRequest(params)) {
      const idJagIssuanceConfig = c.get('config');
      // The ID-JAG is signed with a registered RS256 key so the peer AS can
      // verify it against this OP's JWKS endpoint (same key-selection contract
      // as JARM: RS256 is pinned, the first key of the set may be another alg).
      const idJagSigningKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
      let idJagSigningKey: SigningKey;
      try {
        idJagSigningKey = selectSigningKeyByAlg(idJagSigningKeys, 'RS256');
      } catch {
        c.header('Cache-Control', 'no-store');
        c.header('Pragma', 'no-cache');
        return c.json(
          { error: 'server_error', error_description: 'No RS256 signing key registered for ID-JAG issuance' },
          500,
        );
      }
      // The subject_token is verified against the same JWKS that id_token_hint
      // uses (the OP's own ID Token signing keys) — draft §4.3.3 requires the
      // assertion's audience to be the authenticated client, which
      // processIdJagIssuanceRequest checks.
      const idJagJwks = await c.get('jwksProvider')();

      const idJagIssuanceResponse = await processIdJagIssuanceRequest({
        params,
        client: tokenClient,
        issuer: idJagIssuanceConfig.issuer,
        jwks: idJagJwks,
        signingKey: idJagSigningKey,
        allowedAudiences: idJagConfig.allowedAudiences,
        allowedScopes: idJagConfig.allowedScopes,
        lifetimeSeconds: idJagConfig.idJagLifetimeSeconds,
        // Extension (draft §9.7): when enabled, an actor_token is recorded as
        // the ID-JAG's act claim. Every accepted token type goes through the
        // same resolver, which owns the content validation.
        allowActorTokens: idJagConfig.allowActorTokens,
        ...(idJagConfig.actorTokenResolver === undefined
          ? {}
          : { actorTokenResolver: idJagConfig.actorTokenResolver }),${idJagRefreshSubjectArgs}
      });

      // RFC 6749 §5.1: token responses MUST NOT be cached. The ID-JAG itself is
      // not persisted — it is a self-contained signed grant the peer AS
      // verifies by signature and exp.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(idJagIssuanceResponse);
    }
${idJagTokenExchangeFallbackStep}`
    : '';
  const idJagRedemptionDispatchStep = features.idJag
    ? `
    // --- EXPERIMENTAL: ID-JAG redemption (Cross-App Access, draft §4.4) ----
    // The jwt-bearer grant (RFC 7523 §2.1). The assertion must be an ID-JAG
    // (typ oauth-id-jag+jwt) issued by one of idJagConfig.trustedIdentityProviders
    // for THIS issuer and for the authenticated client. This OP then issues its
    // own access token — the IdP never mints tokens for this AS.
    //
    // No ID Token is issued (this is not an OIDC authentication flow: the
    // openid scope only grants UserInfo access) and no refresh token is issued
    // (draft §4.4.3 SHOULD NOT — re-presenting the still-valid ID-JAG replaces
    // the refresh token).
    if (params.grant_type === JWT_BEARER_GRANT_TYPE) {
      const idJagRedemptionConfig = c.get('config');
      const idJagIdentityProviders = await resolveTrustedIdentityProviders();

      const idJagGrant = await processIdJagRedemptionRequest({
        params,
        client: tokenClient,
        issuer: idJagRedemptionConfig.issuer,
        identityProviders: idJagIdentityProviders,
        configuredExpiresIn: idJagRedemptionConfig.accessTokenExpiresIn,
      });

      // config and the signing key are bound further down for the standard
      // grants. This branch reads them on its own so the generated output is
      // unchanged when the feature is off; it returns, so nothing runs twice.
      // The first registered key signs new tokens (SigningKeyProvider contract).
      const idJagAccessTokenSigningKey: SigningKey = c.get('signingKeys')[0];
      const idJagTokenIssuer: AccessTokenIssuer =
        idJagRedemptionConfig.accessTokenFormat === 'opaque'
          ? createOpaqueAccessTokenIssuer()
          : createJwtAccessTokenIssuer();

      // Same aud policy as the standard token route: the UserInfo endpoint
      // stays a permanent member (RFC 9068 §3); the ID-JAG's resource claim
      // (RFC 8707) contributes the requested resources.
      const idJagAudience = buildAccessTokenAudience({
        userInfoEndpoint: \`\${idJagRedemptionConfig.issuer}/userinfo\`,
        requested: idJagGrant.requestedResources,
        issuer: idJagRedemptionConfig.issuer,
      });

      const idJagIssuedAt = Math.floor(Date.now() / 1000);
      const idJagAccessTokenPayload = buildAccessTokenPayload({
        issuer: idJagRedemptionConfig.issuer,
        subject: idJagGrant.subject,
        clientId: idJagGrant.clientId,
        scope: idJagGrant.scope,
        audience: idJagAudience,
        expiresIn: idJagGrant.expiresIn,
        issuedAt: idJagIssuedAt,
      });
      const idJagAccessToken = await idJagTokenIssuer.issue({
        payload: {
          ...idJagAccessTokenPayload,
          // RFC 8693 §4.1: an act claim carried by the ID-JAG is preserved on
          // the issued access token, so downstream services still see WHO acts
          // on the subject's behalf (dropping it would silently turn the
          // delegation into impersonation).
          ...(idJagGrant.actor === undefined ? {} : { act: idJagGrant.actor }),
        },
        privateKey: idJagAccessTokenSigningKey.privateKey,
        keyId: idJagAccessTokenSigningKey.keyId,
      });

      const idJagAccessTokenMetadata: IdJagAccessTokenInfo = {
        // draft §4.4.1: the ID-JAG's sub is used as the local subject directly
        // (subject resolution by identical sub; JIT provisioning is out of scope).
        sub: idJagGrant.subject,
        clientId: idJagGrant.clientId,
        scope: idJagGrant.scope,
        expiresAt: idJagIssuedAt + idJagGrant.expiresIn,
        // Each redemption is its own grant: revoking one issued token must not
        // affect tokens from other redemptions of the same (re-presentable)
        // ID-JAG, so the payload's own jti doubles as the grant id.
        grantId: idJagAccessTokenPayload.jti,
        iat: idJagIssuedAt,
        nbf: idJagIssuedAt,
        audience: idJagAudience,
        issuer: idJagRedemptionConfig.issuer,
        jti: idJagAccessTokenPayload.jti,
        // The actor record is persisted too, so opaque-token introspection and
        // store-based tooling can surface it just like the JWT claim.
        ...(idJagGrant.actor === undefined ? {} : { act: idJagGrant.actor }),
      };
      await accessTokenStore.set(idJagAccessToken, idJagAccessTokenMetadata);

      // RFC 6749 §5.1: token responses MUST NOT be cached.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json({
        access_token: idJagAccessToken,
        token_type: 'Bearer' as const,
        expires_in: idJagGrant.expiresIn,
        scope: idJagGrant.scope.join(' '),
      });
    }
`
    : '';
  const idJagCatchBranch = features.idJag
    ? `    if (error instanceof IdJagError) {
      // ID-JAG errors use the RFC 6749 §5.2 shape and are always 400 — a 401
      // can only come from client authentication, which runs before both
      // branches and throws core's TokenError. Issuance failures map to
      // invalid_request / invalid_target / invalid_scope / unauthorized_client
      // (RFC 8693 §2.2.2); assertion failures on redemption map to
      // invalid_grant (RFC 7521 §4.1).
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        { error: error.code, error_description: error.errorDescription },
        error.statusCode,
      );
    }
`
    : '';
  return `import { Hono } from 'hono';
import {
  validateGrantTypeSupported,
  resolveAuthenticatedTokenClient,
  validateClientGrantType,
  resolveAuthorizationCode,
  validateAuthorizationCodeUnused,
  validateAuthorizationCodeClient,
  validateAuthorizationCodeExpiration,
  validateAuthorizationCodeRedirectUri,
  verifyAuthorizationCodePkce,
  consumeAuthorizationCode,
  buildValidatedAuthorizationCodeRequest,${refreshGrantImport}
  buildAccessTokenPayload,
  computeAtHash,
  resolveAcrAmr,
  buildIdTokenPayload,
  generateIdToken,${randomStringImport}
  buildAccessTokenAudience,
  extractClientCredentials,
  validateClientAuthMethod,
  verifyClientSecret,
  createJwtAccessTokenIssuer,
  createOpaqueAccessTokenIssuer,
  selectSigningKeyByAlg,
  TokenError,
  TokenErrorCode,
  type AccessTokenIssuer,
  type AcrResolver,
  type SigningKey,
  type TokenRequestParams,
  type ValidatedTokenRequest,
} from '${corePkg}';
import {
  tokenClientResolver as defaultTokenClientResolver,
  authorizationCodeResolver as defaultAuthorizationCodeResolver,${refreshResolverImport}${tokenExchangeResolverImport}
} from '../resolvers.js';
import {
  accessTokenStore as defaultAccessTokenStore,
  authCodeStore as defaultAuthCodeStore,${refreshStoreImport}
} from '../store.js';
import type { RegisteredClient } from '../config.js';${tokenExchangeImports}${idJagImports}${deviceGrantImports}${cibaGrantImports}
${tokenExchangeConfigBlock}${idJagConfigBlock}
export const tokenApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * Narrows raw body params to the typed TokenRequestParams.
 * Returns false when the required grant_type field is absent.
 */
function isTokenRequestParams(
  params: unknown,
): params is TokenRequestParams {
  if (typeof params !== 'object' || params === null) return false;
  const p = params as Record<string, unknown>;
  return typeof p['grant_type'] === 'string';
}

/**
 * Returns true when the Content-Type names application/x-www-form-urlencoded.
 * RFC 6749 §4.1.3 / Appendix B / OIDC Core 1.0 §3.1.3.1: the Token Request
 * entity-body MUST be application/x-www-form-urlencoded. Media types are
 * case-insensitive (RFC 9110 §8.3.1) and may carry parameters such as
 * "; charset=UTF-8", so we lowercase and strip everything after the first ';'.
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

/**
 * Token Endpoint
 * OIDC Core 1.0 Section 3.1.3
 */
tokenApp.post('/', async (c) => {
  // RFC 6749 §4.1.3 / OIDC Core 1.0 §3.1.3.1: reject any body that is not
  // application/x-www-form-urlencoded (e.g. multipart/form-data, application/json)
  // before parsing so a non-form payload is never consumed as token parameters.
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    // RFC 6749 Section 5.2: error responses MUST set Cache-Control: no-store / Pragma: no-cache.
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'invalid_request', error_description: 'Token requests must use application/x-www-form-urlencoded' }, 400);
  }

  // RFC 6749 §3.2: token endpoint request parameters MUST NOT be repeated.
  // Read the raw form body so URLSearchParams iteration exposes duplicate keys
  // instead of letting parseBody silently keep only the last value.
  const rawBody = await c.req.text();
  const searchParams = new URLSearchParams(rawBody);
  const rawParams: Record<string, string> = {};
  const seen = new Set<string>();
  let duplicateKey: string | undefined;
  for (const [key, value] of searchParams) {
    if (seen.has(key)) {
      duplicateKey = key;
      break;
    }
    seen.add(key);
    rawParams[key] = value;
  }
  const authorization = c.req.header('Authorization') ?? '';

  if (duplicateKey !== undefined) {
    // RFC 6749 Section 5.2: error responses MUST set Cache-Control: no-store / Pragma: no-cache.
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'invalid_request', error_description: \`Parameter "\${duplicateKey}" must not be repeated\` }, 400);
  }

  if (!isTokenRequestParams(rawParams)) {
    // RFC 6749 Section 5.2: error responses MUST set Cache-Control: no-store / Pragma: no-cache.
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'invalid_request', error_description: 'Missing required parameter: grant_type' }, 400);
  }

  const params = rawParams;

  try {
    const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
    const authorizationCodeResolver =
      c.get('authCodeResolver') ?? defaultAuthorizationCodeResolver;
${refreshResolverConst}    const authCodeStore = c.get('authCodeStore') ?? defaultAuthCodeStore;
    const accessTokenStore = c.get('accessTokenStore') ?? defaultAccessTokenStore;
${refreshStoreConst}
    // --- Client authentication pipeline -------------------------------------
    // OAuth 2.1 §2.3 / OIDC Core 1.0 §9: client_secret_basic / client_secret_post.
    // Each step below is an independent core function. Replace
    // verifyClientSecret with your own assertion check (e.g. private_key_jwt)
    // without touching the rest.

    // Read the presented credentials and which method was actually used.
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: authorization,
    });

    // RFC 6749 §5.2: the presented client_id must resolve to a registered client.
    const tokenClient = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      tokenClientResolver,
    );

    // OIDC Core 1.0 §9: the method used must match the registered
    // token_endpoint_auth_method (blocks auth method downgrade / public-client mixups).
    validateClientAuthMethod(tokenClient, presentedCredentials);

    // OAuth 2.1 §7.4.1: constant-time client_secret comparison.
    await verifyClientSecret(tokenClient, presentedCredentials.clientSecret);

    const authenticatedClientId = presentedCredentials.clientId;
${idJagIssuanceDispatchStep}${idJagRedemptionDispatchStep}${tokenExchangeDispatchStep}${deviceCodeDispatchStep}${cibaDispatchStep}
    // --- Token request validation pipeline --------------------------------
    // Each step below is an independent core function. Delete a call to drop
    // that validation, or insert your own logic between steps.

${grantTypeSupportedStep}
    // RFC 6749 §5.2: per-client grant_type authorization (unauthorized_client).
    validateClientGrantType(tokenClient, grantType);

${grantValidationStep}

    const config = c.get('config');
    // The first registered key signs new tokens (SigningKeyProvider contract).
    const signingKey: SigningKey = c.get('signingKeys')[0];
    const privateKey = signingKey.privateKey;
    const keyId = signingKey.keyId;

    // T-022: pick an ID Token signing key whose alg matches the client's
    // id_token_signed_response_alg (OIDC Dynamic Client Registration §2).
    // - 未指定クライアントは OIDC 仕様デフォルトの RS256 で扱う。
    // - alg に合う鍵が登録されていなければサーバ設定エラー (server_error)。
    const idTokenSigningKeys = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
    const registeredClient = (await tokenClientResolver.findClient(authenticatedClientId)) as
      | RegisteredClient
      | null;
    const requestedIdTokenAlg = registeredClient?.idTokenSignedResponseAlg;
    let selectedIdTokenKey: SigningKey;
    try {
      selectedIdTokenKey = selectSigningKeyByAlg(idTokenSigningKeys, requestedIdTokenAlg);
    } catch {
      return c.json(
        {
          error: 'server_error',
          error_description: \`No ID Token signing key registered for alg "\${requestedIdTokenAlg ?? 'RS256'}"\`,
        },
        500,
      );
    }
    const idTokenPrivateKey = selectedIdTokenKey.privateKey;
    const idTokenKeyId = selectedIdTokenKey.keyId;

    let subject: string;
    let authTime: number | undefined;
    let nonce: string | undefined;

    if (validatedRequest.grantType === 'authorization_code') {
      const authCode = await authCodeStore.get(validatedRequest.code);
      if (!authCode?.subject || !authCode.authTime) {
        throw new TokenError(
          TokenErrorCode.InvalidGrant,
          'Authorization code missing required subject context',
        );
      }
      subject = authCode.subject;
      authTime = authCode.authTime;
      nonce = validatedRequest.nonce;
    } else {
      // refresh_token grant
      // OIDC Core 1.0 §12.2: the re-issued ID Token retains iss/sub/aud/exp/iat/
      // auth_time/azp/acr/amr — nonce is NOT in that list. nonce binds an
      // Authentication Request to its ID Token (§2); a refresh has no such request,
      // so carrying the old nonce adds no replay protection. Major OPs (Google,
      // Auth0) omit it on refresh, so we omit it here by default. auth_time is
      // still preserved per §12.1.
      subject = validatedRequest.subject;
      authTime = validatedRequest.authTime;
      nonce = undefined;
    }

    // Choose access token issuer based on config (default: JWT).
    // Opaque tokens are recommended when immediate revocation is required,
    // since the resource server can call the introspection endpoint instead
    // of self-validating a JWT.
    const accessTokenIssuer: AccessTokenIssuer =
      config.accessTokenFormat === 'opaque'
        ? createOpaqueAccessTokenIssuer()
        : createJwtAccessTokenIssuer();

    // アクセストークンの audience を決定する（合成ポリシーは core の buildAccessTokenAudience に集約）。
    // RFC 9068 §3: JWT access token の aud は非空でなければならない。
    // このアクセストークンは常に OP 自身の UserInfo エンドポイントで使用できるため、UserInfo
    // エンドポイント（discovery が広告する userinfo_endpoint と同じ URL）を aud の恒久メンバとして
    // 必ず含める。resource 指定（validatedRequest.audience）があれば末尾に追加し、UserInfo
    // エンドポイントを取り除くことはしない。重複は除去される。
    // refresh では保存済み aud（既に UserInfo を含む）を引き継ぐため、再計算しても同一集合になる。
    const effectiveAudience = buildAccessTokenAudience({
      userInfoEndpoint: \`\${config.issuer}/userinfo\`,
      requested: validatedRequest.audience,
      issuer: config.issuer,
    });

    // T-015: acr / amr resolver injection.
    // - authorization_code: pass acrResolver so the host app can decide acr / amr policy.
    // - refresh_token: pass stored acr / amr directly so OIDC Core 1.0 §12.1 SHOULD
    //   "preserve initial auth context" is satisfied; resolver is bypassed.
    const acrResolver = c.get('acrResolver') as AcrResolver | undefined;
    const directAcr = validatedRequest.grantType === 'refresh_token' ? validatedRequest.acr : undefined;
    const directAmr = validatedRequest.grantType === 'refresh_token' ? validatedRequest.amr : undefined;

${grantHasOfflineAccessBlock}    // --- Token response pipeline --------------------------------------------
    // Each step below is an independent core function. Add your own ID Token
    // claims by editing idTokenPayload before it is signed, or swap in another
    // issuer.

    // One timestamp for the whole response so the issued tokens and the stored
    // token metadata agree on iat / exp.
    const issuedAt = Math.floor(Date.now() / 1000);

    // RFC 9068 §2.2: iss / sub / aud / exp / iat / scope / client_id.
    // Add access token claims here before the payload is signed.
    const accessTokenPayload = buildAccessTokenPayload({
      issuer: config.issuer,
      subject,
      clientId: validatedRequest.clientId,
      scope: validatedRequest.scope,
      audience: effectiveAudience,
      expiresIn: config.accessTokenExpiresIn,
      issuedAt,
    });

    // JWT or opaque, chosen above from config.accessTokenFormat.
    const accessToken = await accessTokenIssuer.issue({
      payload: accessTokenPayload,
      privateKey,
      keyId,
    });

    // OIDC Core 1.0 §12: refresh_token grant でも id_token は MAY。
    // openid scope を持つ場合は §12.1 に従い初回認証時と同じ auth_time / acr / amr / azp で再発行する。
    // （§12.2 は nonce を再発行 ID Token の保持クレームに挙げないため nonce は refresh では undefined）
    let idToken: string | undefined;
    let resolvedAcr: string | undefined = undefined;
    let resolvedAmr: string[] | undefined = undefined;
    if (validatedRequest.scope.includes('openid')) {
      // OIDC Core 1.0 §3.1.3.6: at_hash binds the ID Token to this access token.
      // The hash function follows the ID Token signing alg.
      const atHash = await computeAtHash(accessToken, idTokenPrivateKey);

      // T-015: acr / amr resolution.
      // - authorization_code: ask the host app's AcrResolver (acr_values / claims
      //   are forwarded so it can honor the request).
      // - refresh_token: pass the stored acr / amr directly so OIDC Core 1.0 §12.1
      //   "preserve initial auth context" holds; the resolver is bypassed.
      ({ acr: resolvedAcr, amr: resolvedAmr } = await resolveAcrAmr({
        subject,
        clientId: validatedRequest.clientId,
        acr: directAcr,
        amr: directAmr,
        acrResolver: validatedRequest.grantType === 'authorization_code' ? acrResolver : undefined,
        requestedAcrValues:
          validatedRequest.grantType === 'authorization_code' ? validatedRequest.acrValues : undefined,
        // OIDC Core 1.0 §5.5: the parsed claims request lets the resolver satisfy
        // id_token member requests (e.g. acr.values).
        claims: validatedRequest.grantType === 'authorization_code' ? validatedRequest.claims : undefined,
      }));

      const idTokenPayload = buildIdTokenPayload({
        issuer: config.issuer,
        subject,
        clientId: validatedRequest.clientId,
        scope: validatedRequest.scope,
        expiresIn: config.idTokenExpiresIn,
        issuedAt,
        atHash,
        nonce,
        authTime,
        acr: resolvedAcr,
        amr: resolvedAmr,
      });

      // Add your own ID Token claims here, e.g.:
      //   idTokenPayload.tenant_id = await lookupTenant(subject);

      idToken = await generateIdToken({
        payload: idTokenPayload,
        privateKey: idTokenPrivateKey,
        keyId: idTokenKeyId,
      });
    }

    // OIDC Core 1.0 §3.1.3.3 / RFC 6749 §5.1: the token response body.
    const tokenResponse = {
      access_token: accessToken,
      token_type: 'Bearer' as const,
      expires_in: config.accessTokenExpiresIn,
      id_token: idToken,
      scope: validatedRequest.scope.join(' '),
      refresh_token: ${refreshTokenValueExpression},
    };

    // Store access token info for UserInfo / Introspection / Revocation endpoints.
    // iat / nbf / audience / issuer are kept so RFC 7662 introspection can echo them.
    // grantId binds this token to the original authorization grant so it can be
    // revoked together with sibling tokens on code reuse (OAuth 2.1 Section 4.1.2).
    await accessTokenStore.set(tokenResponse.access_token, {
      sub: subject,
      clientId: validatedRequest.clientId,
      scope: validatedRequest.scope,
      expiresAt: issuedAt + config.accessTokenExpiresIn,
      grantId: validatedRequest.grantId,
      iat: issuedAt,
      // RFC 7519 §4.1.5 / RFC 7662 §2.2: persist nbf (= iat) for JWT and opaque
      // tokens alike so introspection reports a not-yet-valid token inactive and
      // can echo nbf. The JWT issuer emits the same nbf = iat inside the token.
      nbf: issuedAt,
      audience: effectiveAudience,
      issuer: config.issuer,
      // RFC 9068 §2.2 / RFC 7662 §2.2: persist the token identifier core minted
      // for this issuance so introspection can echo jti. It is also what makes
      // two same-second issuances distinct token strings (RS256 is deterministic),
      // so this store key never collides across grants.
      jti: accessTokenPayload.jti,
      // OIDC Core 1.0 §5.5: persist the authorization request's claims parameter
      // so the UserInfo endpoint can honor claims.userinfo members (e.g.
      // {"userinfo":{"name":{"essential":true}}}) independently of scope.
      claims: validatedRequest.grantType === 'authorization_code' ? validatedRequest.claims : undefined,
    });

${refreshTokenPersistenceBlock}    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(tokenResponse);
  } catch (error) {
${idJagCatchBranch}${tokenExchangeCatchBranch}${deviceGrantCatchBranch}${cibaGrantCatchBranch}    if (error instanceof TokenError) {
      const status = error.statusCode as 400 | 401;
      // RFC 6750 Section 3 / OAuth 2.1 Section 5.2: 401 responses include WWW-Authenticate
      if (error.wwwAuthenticate) {
        c.header('WWW-Authenticate', error.wwwAuthenticate);
      }
      // RFC 6749 Section 5.2: error responses MUST set Cache-Control: no-store / Pragma: no-cache.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        { error: error.error, error_description: error.errorDescription },
        status,
      );
    }
    // RFC 6749 Section 5.2: server_error responses MUST NOT be cached either.
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'server_error' }, 500);
  }
});
`;
}

export function userinfoRouteTemplate(corePkg: string): string {
  return `import { Hono } from 'hono';
import {
  resolveUserInfoAccessToken,
  validateUserInfoTokenExpiration,
  validateUserInfoScope,
  validateUserInfoAudience,
  resolveUserInfoClaims,
  filterClaimsByScope,
  applyRequestedClaims,
  generateUserInfoJwt,
  selectSigningKeyByAlg,
  UserInfoError,
  type SigningKey,
} from '${corePkg}';
import {
  accessTokenResolver as defaultAccessTokenResolver,
  userClaimsResolver as defaultUserClaimsResolver,
  clientResolver as defaultClientResolver,
} from '../resolvers.js';
import type { RegisteredClient } from '../config.js';

export const userinfoApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * Extract the access token from the request, supporting:
 * - Authorization: Bearer header (RFC 6750 Section 2.1, REQUIRED)
 * - access_token form body parameter on POST (RFC 6750 Section 2.2, OPTIONAL)
 *
 * Per RFC 6750 Section 2, clients MUST NOT use more than one method per request.
 * URL query parameter (Section 2.3) is intentionally NOT supported (OAuth 2.1 prohibits it).
 */
async function extractAccessToken(c: any): Promise<{ token: string; methodCount: number }> {
  const authHeader = c.req.header('Authorization') ?? '';
  // RFC 7235 Section 2.1: HTTP authentication scheme is case-insensitive.
  // Match the "Bearer" scheme case-insensitively but preserve the token value verbatim.
  const bearerSpaceIndex = authHeader.indexOf(' ');
  const headerToken =
    bearerSpaceIndex !== -1 &&
    authHeader.slice(0, bearerSpaceIndex).toLowerCase() === 'bearer'
      ? authHeader.slice(bearerSpaceIndex + 1)
      : '';

  let bodyToken = '';
  if (c.req.method === 'POST') {
    const contentType = c.req.header('Content-Type') ?? '';
    const mediaType = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
    if (mediaType === 'application/x-www-form-urlencoded') {
      // Parse the form payload ourselves after media-type normalization. Hono's
      // parseBody() dispatch is case-sensitive for some Content-Type spellings.
      const body = Object.fromEntries(new URLSearchParams(await c.req.text()));
      const candidate = body['access_token'];
      if (typeof candidate === 'string') {
        bodyToken = candidate;
      }
    }
  }

  const methodCount = (headerToken ? 1 : 0) + (bodyToken ? 1 : 0);
  return { token: headerToken || bodyToken, methodCount };
}

/**
 * UserInfo Endpoint
 * OIDC Core 1.0 Section 5.3
 *
 * Response format is selected by the client metadata \`userinfo_signed_response_alg\`:
 * - When present (e.g. 'RS256'), respond as a signed JWT with content-type application/jwt
 *   (OIDC Core 1.0 Section 5.3.2).
 * - When absent, respond as application/json.
 */
const handler = async (c: any) => {
  // RFC 6750 Section 5.2 / OIDC Core 1.0 Section 16.4:
  // UserInfo responses (success and error) expose PII and must not be cached
  // by intermediaries. Set the no-cache headers once up-front so every branch
  // below inherits them.
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  let accessToken: string;
  try {
    const { token, methodCount } = await extractAccessToken(c);
    if (methodCount > 1) {
      // RFC 6750 Section 2: clients MUST NOT use more than one method per request.
      c.header('WWW-Authenticate', 'Bearer realm="UserInfo", error="invalid_request"');
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Multiple access token methods are not allowed',
        },
        400,
      );
    }
    accessToken = token;
    if (!accessToken) {
      // RFC 6750 §3.1: when the request has no authentication information, the
      // challenge omits error/error_description and only identifies the realm.
      c.header('WWW-Authenticate', 'Bearer realm="UserInfo"');
      return c.json(
        { error: 'invalid_token', error_description: 'Access token is required' },
        401,
      );
    }
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }

  try {
    const accessTokenResolver =
      c.get('accessTokenResolver') ?? defaultAccessTokenResolver;
    const userClaimsResolver =
      c.get('userClaimsResolver') ?? defaultUserClaimsResolver;
    const clientResolver = c.get('clientResolver') ?? defaultClientResolver;

    // --- UserInfo request pipeline ------------------------------------------
    // Each step below is an independent core function. Delete a call to drop
    // that validation, or insert your own logic between steps. Every step
    // throws UserInfoError, which the catch block below renders as an RFC 6750
    // Bearer challenge.

    // OIDC Core 1.0 §5.3.1: resolve the presented Bearer token (invalid_token when unknown).
    const tokenInfo = await resolveUserInfoAccessToken(accessToken, accessTokenResolver);

    // RFC 6750 §3.1: an expired access token is invalid_token.
    validateUserInfoTokenExpiration(tokenInfo);

    // OIDC Core 1.0 §5.3.1: the token must carry the openid scope (insufficient_scope).
    validateUserInfoScope(tokenInfo);

    // RFC 9068 §4: this UserInfo endpoint must appear in the access token's aud.
    // The token endpoint always stores the UserInfo endpoint URL in aud
    // (buildAccessTokenAudience), so audience validation is on by default for
    // both JWT and opaque tokens. Pass undefined to turn it off.
    validateUserInfoAudience(tokenInfo, \`\${c.get('config').issuer}/userinfo\`);

    // Load every claim the OP knows about the token's subject.
    const userClaims = await resolveUserInfoClaims(tokenInfo, userClaimsResolver);

    // OIDC Core 1.0 §5.4: keep only the claims the granted scopes allow.
    const scopedResponse = filterClaimsByScope(userClaims, tokenInfo.scope);

    // OIDC Core 1.0 §5.5: overlay the individually requested claims that the
    // token endpoint stored with this access token (claims.userinfo members).
    const response = applyRequestedClaims(scopedResponse, userClaims, tokenInfo.claims);

    const client = (await clientResolver.findClient(
      tokenInfo.clientId,
    )) as RegisteredClient | null;

    const requestedUserinfoAlg = client?.userinfoSignedResponseAlg;
    if (requestedUserinfoAlg) {
      // OIDC Core 1.0 §5.3.2: when the client registered userinfo_signed_response_alg,
      // the UserInfo Response MUST be a JWS signed with THAT alg (RS256, ES256, ...),
      // not unconditionally RS256. Pick a registered UserInfo signing key whose alg
      // matches the request — mirroring the ID Token key selection. A request whose
      // alg has no matching key is a server configuration error (never silently
      // signed with another alg).
      const config = c.get('config');
      const userinfoSigningKeys = (c.get('userinfoSigningKeys') as SigningKey[] | undefined) ?? [];
      let selectedUserinfoKey: SigningKey;
      try {
        selectedUserinfoKey = selectSigningKeyByAlg(userinfoSigningKeys, requestedUserinfoAlg);
      } catch {
        return c.json(
          {
            error: 'server_error',
            error_description: \`No UserInfo signing key registered for alg "\${requestedUserinfoAlg}"\`,
          },
          500,
        );
      }
      const jwt = await generateUserInfoJwt(response, {
        issuer: config.issuer,
        audience: client.clientId,
        privateKey: selectedUserinfoKey.privateKey,
        keyId: selectedUserinfoKey.keyId,
      });
      c.header('Content-Type', 'application/jwt');
      return c.body(jwt);
    }

    return c.json(response);
  } catch (error) {
    if (error instanceof UserInfoError) {
      const status = error.statusCode as 401 | 403;
      c.header(
        'WWW-Authenticate',
        \`Bearer realm="UserInfo", error="\${error.error}", error_description="\${error.errorDescription}"\`,
      );
      return c.json(
        { error: error.error, error_description: error.errorDescription },
        status,
      );
    }
    return c.json({ error: 'server_error' }, 500);
  }
};

userinfoApp.get('/', handler);
userinfoApp.post('/', handler);
`;
}

export function jwksRouteTemplate(corePkg: string): string {
  return `import { Hono } from 'hono';
import { exportJwks, extractAlgorithmParamsFromJwk, type SigningKey } from '${corePkg}';

export const jwksApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * JWKS Endpoint
 * Serves the public keys used to verify token signatures.
 *
 * T-022: every key of the per-purpose key sets (signingKeys / idTokenSigningKeys /
 * userinfoSigningKeys) is published so rotated-out keys remain verifiable until
 * tokens signed with them expire. kid 指定がある鍵は kid で重複排除し、kid 未指定の
 * 鍵は最新の 1 件のみ採用する（鍵セットは新しい鍵ほど先頭にある）。
 */
jwksApp.get('/', async (c) => {
  const keys: SigningKey[] = [
    ...((c.get('signingKeys') as SigningKey[] | undefined) ?? []),
    ...((c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? []),
    ...((c.get('userinfoSigningKeys') as SigningKey[] | undefined) ?? []),
  ];

  if (keys.length === 0) {
    return c.json({ error: 'server_error' }, 500);
  }

  // 同じ kid の鍵は最初に出現したものだけを採用する（ID Token / UserInfo 用の
  // プロバイダは既定で汎用プロバイダと同じ鍵を返すため）。kid 未指定の鍵も同様に
  // 最初の 1 件（= 最新）だけを採用する。
  const seenKids = new Set<string>();
  const entries: { publicKey: CryptoKey; keyId?: string }[] = [];
  for (const key of keys) {
    if (seenKids.has(key.keyId)) continue;
    seenKids.add(key.keyId);
    const jwk = key.publicJwk as JsonWebKey;
    const algParams = extractAlgorithmParamsFromJwk(jwk);
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      algParams,
      true,
      ['verify'],
    );
    entries.push({ publicKey, keyId: key.keyId });
  }

  const jwks = await exportJwks(entries);

  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(jwks);
});
`;
}

export function discoveryRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  scopes: string[] = [],
): string {
  // --scope: the declared scopes live in scopes.ts, which also owns the standard
  // list, so the advertisement reads from there instead of repeating it. Without
  // a declaration the literal below is unchanged.
  const customScopesDeclared = scopes.length > 0;
  const customScopeImport = customScopesDeclared
    ? `
import { SUPPORTED_SCOPES } from '../scopes.js';`
    : '';
  const scopesSupportedEntry = customScopesDeclared
    ? `    // OIDC Discovery 1.0 §3: scopes_supported is this OP's scope allow list —
    // the standard scopes plus the custom ones declared with --scope (see
    // scopes.ts). It is OP metadata, so it lists what the provider accepts, not
    // what a particular End-User is granted (resolveGrantableScopes decides that).
    scopesSupported: [...SUPPORTED_SCOPES],
`
    : features.refreshToken
    ? `    // OIDC Core 1.0 §11: offline_access is advertised so relying parties (and the
    // OIDF Conformance Suite's oidcc-refresh-token module) know they may request
    // refresh tokens via 'scope=openid offline_access' with prompt=consent.
    // It is a refresh-token request scope, not a claim scope, so no matching
    // entry is added to claimsSupported.
    scopesSupported: ['openid', 'profile', 'email', 'address', 'phone', 'offline_access'],
`
    : `    // The refresh_token feature is disabled, so offline_access is not advertised
    // (OIDC Core 1.0 §11: it would never be granted by this provider).
    scopesSupported: ['openid', 'profile', 'email', 'address', 'phone'],
`;
  // The list is assembled so that a disabled feature contributes nothing: with
  // every experimental feature off the entry is byte-identical to before.
  // RFC 8693 §2.1: the exchange grant is advertised only when it is generated,
  // so a client can detect support through discovery.
  const supportedGrantTypes = [
    `'authorization_code'`,
    ...(features.refreshToken ? [`'refresh_token'`] : []),
    // EXPERIMENTAL (ID-JAG draft §4.3): issuing an ID-JAG happens on the
    // token-exchange grant, so enabling id-jag alone also advertises it.
    ...(features.tokenExchange || features.idJag
      ? [`'urn:ietf:params:oauth:grant-type:token-exchange'`]
      : []),
    // EXPERIMENTAL (ID-JAG draft §7.2): a resource AS that advertises the
    // id-jag grant profile MUST also advertise the jwt-bearer grant.
    ...(features.idJag ? [`'urn:ietf:params:oauth:grant-type:jwt-bearer'`] : []),
    // RFC 8628 §4: the device grant is advertised only when it is generated, so
    // a client can detect support through discovery.
    ...(features.deviceAuthorizationGrant
      ? [`'urn:ietf:params:oauth:grant-type:device_code'`]
      : []),
    // CIBA Core 1.0 §4: the CIBA grant is advertised only when it is generated,
    // so a client can detect support through discovery.
    ...(features.ciba ? [`'urn:openid:params:grant-type:ciba'`] : []),
  ];
  const grantTypesSupportedEntry = `    grantTypesSupported: [${supportedGrantTypes.join(', ')}],
`;
  const requestObjectMetadata = features.requestObject
    ? `    // OIDC Core 1.0 §6.1 / OIDC Discovery 1.0 §3: signed Request Object by value is
    // supported (verified against the client's registered JWKS). request_uri (§6.2)
    // is not supported, so it is explicitly advertised as false (Discovery defaults
    // request_uri_parameter_supported to true when omitted). RS256 is the required
    // signing alg; 'none' is added only when unsigned objects are accepted for
    // Basic OP conformance compatibility.
    requestParameterSupported: true,
    requestUriParameterSupported: false,
    requestObjectSigningAlgValuesSupported: config.allowUnsignedRequestObject
      ? ['RS256', 'none']
      : ['RS256'],
`
    : `    // OIDC Core 1.0 §6.3: the request parameter (Request Object) is disabled in
    // this generated provider, so request_parameter_supported is advertised as
    // false. request_uri (§6.2) remains unsupported as well.
    requestParameterSupported: false,
    requestUriParameterSupported: false,
`;
  const rfc8414Comment =
    features.introspection && features.revocation
      ? `    // RFC 8414 — both endpoints require confidential client authentication.
`
      : features.introspection || features.revocation
        ? `    // RFC 8414 — the endpoint requires confidential client authentication.
`
        : '';
  const introspectionMetadata = features.introspection
    ? `    introspectionEndpoint: \`\${issuer}/introspect\`,
    introspectionEndpointAuthMethodsSupported: [
      'client_secret_basic',
      'client_secret_post',
    ],
`
    : '';
  const revocationMetadata = features.revocation
    ? `    revocationEndpoint: \`\${issuer}/revoke\`,
    revocationEndpointAuthMethodsSupported: [
      'client_secret_basic',
      'client_secret_post',
    ],
`
    : '';
  // EXPERIMENTAL (JARM §4): response_modes_supported is an existing core
  // DiscoveryConfig field, so the JWT-secured modes are advertised by widening
  // the value the template passes in — no core change.
  const responseModesSupportedEntry = features.jarm
    ? `    // OAuth 2.0 Multiple Response Type Encoding Practices §2 / OIDC Discovery 1.0 §3:
    // the OP only implements the authorization code flow, whose authorization
    // response is returned via query. EXPERIMENTAL (JARM §4): this provider was
    // generated with --enable jarm, so the JWT-secured query modes are advertised
    // alongside it. Extend this list when form_post (or other modes) are added.
    responseModesSupported: ['query', 'query.jwt', 'jwt'],`
    : `    // OAuth 2.0 Multiple Response Type Encoding Practices §2 / OIDC Discovery 1.0 §3:
    // the OP only implements the authorization code flow, whose authorization
    // response is returned via query, so response_modes_supported is pinned to
    // ['query']. Extend this list when form_post (or other modes) are added.
    responseModesSupported: ['query'],`;
  // EXPERIMENTAL (JARM §4): authorization_signing_alg_values_supported has no
  // core DiscoveryConfig field, so it is merged onto the metadata object the
  // same way the PAR endpoint metadata is.
  const jarmDiscoveryMetadata = features.jarm
    ? `
    // EXPERIMENTAL — JARM §4 metadata. The response JWT is always signed with
    // RS256 (JARM §3: the default for a client that registered no
    // authorization_signed_response_alg), so exactly one alg is advertised.
    authorization_signing_alg_values_supported: ['RS256'],`
    : '';
  // EXPERIMENTAL (RFC 9126 §5): pushed_authorization_request_endpoint is merged
  // onto the metadata object core builds, so core needs no change to advertise it.
  const parDiscoveryImport = features.par
    ? `
import { parConfig } from './par.js';`
    : '';
  const parDiscoveryMetadata = features.par
    ? `
    // EXPERIMENTAL — RFC 9126 §5 metadata. require_pushed_authorization_requests
    // is only advertised when PAR is actually enforced (its default is false).
    pushed_authorization_request_endpoint: \`\${issuer}/par\`,
    ...(parConfig.requirePushedAuthorizationRequests
      ? { require_pushed_authorization_requests: true }
      : {}),`
    : '';
  // EXPERIMENTAL (RFC 8628 §4): device_authorization_endpoint has no core
  // DiscoveryConfig field, so it is merged onto the metadata object the same way
  // the PAR endpoint metadata is — core needs no change to advertise it.
  const deviceDiscoveryMetadata = features.deviceAuthorizationGrant
    ? `
    // EXPERIMENTAL — RFC 8628 §4 metadata.
    device_authorization_endpoint: \`\${issuer}/device_authorization\`,`
    : '';
  // EXPERIMENTAL (CIBA Core 1.0 §4): both REQUIRED metadata entries are merged
  // onto the metadata object core builds, so core needs no change to advertise
  // them. The OPTIONAL entries (signing algs, user code support) are not
  // output: this build supports neither signed requests nor user codes.
  const cibaDiscoveryMetadata = features.ciba
    ? `
    // EXPERIMENTAL — CIBA Core 1.0 §4 metadata. Only the poll delivery mode is
    // offered, so exactly one mode is advertised.
    backchannel_token_delivery_modes_supported: ['poll'],
    backchannel_authentication_endpoint: \`\${issuer}/backchannel_authentication\`,`
    : '';
  // EXPERIMENTAL (ID-JAG draft §7): both role advertisements are merged onto
  // the metadata object core builds, so core needs no change. Only the profile
  // support is advertised — the trusted-IdP list and the audience allow list
  // are deliberately NOT disclosed (draft §9.4 MUST NOT).
  const idJagDiscoveryMetadata = features.idJag
    ? `
    // EXPERIMENTAL — ID-JAG draft §7.1: this OP can issue an ID-JAG via token
    // exchange (identity-chaining requested token type).
    identity_chaining_requested_token_types_supported: ['urn:ietf:params:oauth:token-type:id-jag'],
    // EXPERIMENTAL — ID-JAG draft §7.2: this OP can process the ID-JAG grant
    // profile on the jwt-bearer grant. Which issuers are actually trusted is
    // local policy and is not disclosed here (draft §9.4).
    authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag'],`
    : '';
  // EXPERIMENTAL (RFC 9701 §7): introspection_signing_alg_values_supported has
  // no core DiscoveryConfig field, so it is merged onto the metadata object the
  // same way the PAR endpoint metadata is. Advertised only when the
  // introspection endpoint itself is generated (resolveFeatures already rejects
  // the combination, but a programmatic OidcFeatureConfig bypasses it).
  const jwtIntrospectionResponseDiscoveryMetadata =
    features.introspection && features.jwtIntrospectionResponse
      ? `
    // EXPERIMENTAL — RFC 9701 §7 metadata. The introspection response JWT is
    // always signed with RS256 (§6: the default for a client that registered no
    // introspection_signed_response_alg), so exactly one alg is advertised.
    introspection_signing_alg_values_supported: ['RS256'],`
      : '';
  // EXPERIMENTAL (RP-Initiated Logout 1.0 §2.1): end_session_endpoint has no
  // core DiscoveryConfig field, so it is merged onto the metadata object the
  // same way the PAR endpoint metadata is — core needs no change to advertise it.
  const rpInitiatedLogoutDiscoveryMetadata = features.rpInitiatedLogout
    ? `
    // EXPERIMENTAL — RP-Initiated Logout 1.0 §2.1 metadata.
    end_session_endpoint: \`\${issuer}/logout\`,`
    : '';
  return `import { Hono } from 'hono';
import { buildProviderMetadata, getJwaAlgorithm, type SigningKey } from '${corePkg}';
import { defaultProviderConfig } from '../config.js';${parDiscoveryImport}${customScopeImport}

export const discoveryApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * OpenID Connect Discovery Endpoint
 * OIDC Discovery 1.0 Section 4
 */
discoveryApp.get('/', (c) => {
  const config = c.get('config') ?? defaultProviderConfig;
  const issuer = config.issuer;

  // Derive id_token_signing_alg_values_supported from the actual key set
  // (OIDC Core 1.0 §15.1 — RS256 presence is enforced by buildProviderMetadata).
  // T-022: 全 registered ID Token 鍵の alg を集約することで RS256+ES256 など
  // 混在鍵セットも正しく advertise できる。
  const idTokenSigningKeyArr = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
  const idTokenSigningKeys: CryptoKey[] = idTokenSigningKeyArr.map((k) => k.privateKey);

  // OIDC Core 1.0 §5.3.2 / §3 discovery: advertise the UserInfo signing algs the OP
  // can actually sign with, derived from the registered UserInfo key set (RS256,
  // ES256, ...), so userinfo_signed_response_alg clients can rely on metadata.
  const userinfoSigningKeyArr = (c.get('userinfoSigningKeys') as SigningKey[] | undefined) ?? [];
  const userinfoSigningAlgValues = [
    ...new Set(userinfoSigningKeyArr.map((k) => getJwaAlgorithm(k.privateKey))),
  ];

  const metadata = buildProviderMetadata({
    issuer,
    authorizationEndpoint: \`\${issuer}/authorize\`,
    tokenEndpoint: \`\${issuer}/token\`,
    jwksUri: \`\${issuer}/.well-known/jwks.json\`,
    responseTypesSupported: ['code'],
${responseModesSupportedEntry}
    subjectTypesSupported: ['public'],
    idTokenSigningKeys,
    userinfoEndpoint: \`\${issuer}/userinfo\`,
${scopesSupportedEntry}    // OIDC Discovery 1.0 §3 / Core 1.0 §5.6: this OP produces Normal Claims only
    // (no _claim_names / _claim_sources), so advertise ['normal'] explicitly to make
    // the lack of Aggregated/Distributed support machine-readable.
    claimTypesSupported: ['normal'],
    claimsSupported: [
      'sub',
      'iss',
      'aud',
      'exp',
      'iat',
      // OIDC Core 1.0 §2 / §3.1.3.6: ID Token protocol claims the OP issues
      // (id-token.ts). auth_time/nonce/acr/amr are set from the auth context,
      // azp for multi-audience tokens, at_hash for code flow access tokens.
      // c_hash is intentionally omitted (Hybrid flow is not implemented).
      'auth_time',
      'nonce',
      'acr',
      'amr',
      'azp',
      'at_hash',
      'name',
      'family_name',
      'given_name',
      'middle_name',
      'nickname',
      'preferred_username',
      'profile',
      'picture',
      'website',
      'gender',
      'birthdate',
      'zoneinfo',
      'locale',
      'updated_at',
      'email',
      'email_verified',
      'address',
      'phone_number',
      'phone_number_verified',
    ],
${grantTypesSupportedEntry}    // RFC 6749 §2.1 / OAuth 2.1 §2.4: 'none' advertises that public clients
    // (no client_secret) are accepted at the token endpoint.
    tokenEndpointAuthMethodsSupported: [
      'client_secret_basic',
      'client_secret_post',
      'none',
    ],
    // Required when any client uses userinfo_signed_response_alg
    // (OIDC Core 1.0 Section 5.3.2). Derived from the registered UserInfo key set so
    // ES256 (and other) algs are advertised once a matching key is configured.
    userinfoSigningAlgValuesSupported: userinfoSigningAlgValues,
${requestObjectMetadata}    // OIDC Discovery 1.0 §3 / Core 1.0 §5.5: the 'claims' request parameter is
    // implemented for both the ID Token and UserInfo paths, so it is advertised
    // as supported. Without this (defaults to false) spec-compliant RPs would
    // never send the 'claims' parameter.
    claimsParameterSupported: true,
    // RFC 9207 §3: authorize endpoint adds iss to all authorization responses.
    authorizationResponseIssParameterSupported: true,
${rfc8414Comment}${introspectionMetadata}${revocationMetadata}  });

  // RFC 8414 §3.2 / RFC 9111 §5.2: Discovery metadata is cacheable. Advertise a
  // 3600s freshness lifetime, symmetric with the JWKS endpoint (jwks.ts), so
  // client libraries reuse the metadata deterministically.
  c.header('Cache-Control', 'public, max-age=3600');
  // code_challenge_methods_supported is defined in OAuth 2.1 / PKCE spec,
  // not in OIDC Discovery, so it is added separately.
  return c.json({
    ...metadata,
    code_challenge_methods_supported: ['S256'],${parDiscoveryMetadata}${deviceDiscoveryMetadata}${cibaDiscoveryMetadata}${jarmDiscoveryMetadata}${idJagDiscoveryMetadata}${jwtIntrospectionResponseDiscoveryMetadata}${rpInitiatedLogoutDiscoveryMetadata}
  });
});
`;
}

export function loginRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  // EXTENSION (google-login): everything below collapses to '' when the feature
  // is off, so the default login logic is unchanged byte for byte.
  const googleLoginImports = features.googleLogin
    ? `
import {
  handleGoogleLoginRedirect,
  issueGoogleLoginNonce,
  resolveGoogleLoginSubject,
  GoogleLoginError,
  type GoogleIdTokenPayload,
} from '${GOOGLE_LOGIN_PACKAGE}';
import {
  buildGoogleSignInAttributes,
  type GoogleSignInAttributes,
} from '${GOOGLE_LOGIN_PACKAGE}/sign-in';`
    : '';
  const googleStoreImport = features.googleLogin
    ? `
  googleLoginNonceStore as defaultGoogleLoginNonceStore,`
    : '';
  const googleConfigImport = features.googleLogin
    ? `
import { defaultProviderConfig, type GoogleLoginConfig } from '../config.js';`
    : '';
  const googleScreenField = features.googleLogin
    ? `
  /**
   * EXTENSION (google-login): the GIS configuration (g_id_onload attributes) of
   * the "Sign in with Google" button; undefined until config.googleLogin is set.
   */
  googleSignIn?: GoogleSignInAttributes;`
    : '';
  const googleScreenValue = features.googleLogin
    ? `
    googleSignIn: await buildGoogleSignIn(c, transactionId, transaction),`
    : '';
  // Only the Google button needs the request context and the transaction id
  // (its nonce is bound to the transaction); keep the plain helper free of
  // unused parameters so strict generated projects still compile.
  const screenContextParam = features.googleLogin ? '  c: any,\n  transactionId: string,\n' : '';
  const screenContextArg = features.googleLogin ? 'c, transactionId, ' : '';
  const preparedScreenArgs = features.googleLogin
    ? 'c, loaded.transactionId, loaded.transaction'
    : 'loaded.transaction';
  const googleLoginHelpers = features.googleLogin
    ? `
/**
 * EXTENSION (google-login): build the GIS configuration (the g_id_onload
 * attributes) for this transaction, or undefined when config.googleLogin is not
 * set. Rendering is the view's job (views.ts): the package generates no UI.
 * Every description of the form issues a fresh nonce bound to the transaction:
 * Google echoes it in the ID token, which is how completeGoogleLogin() finds
 * its way back to this authorization request (the redirect-mode POST carries
 * nothing else).
 */
async function buildGoogleSignIn(
  c: any,
  transactionId: string,
  transaction: AuthTransaction,
): Promise<GoogleSignInAttributes | undefined> {
  const config = c.get('config') ?? defaultProviderConfig;
  const googleLogin: GoogleLoginConfig | undefined = config.googleLogin;
  if (!googleLogin) return undefined;
  const nonceStore = c.get('googleLoginNonceStore') ?? defaultGoogleLoginNonceStore;
  const nonce = await issueGoogleLoginNonce({
    transactionId,
    expiresAt: transaction.expiresAt,
    store: nonceStore,
  });
  return buildGoogleSignInAttributes({
    clientId: googleLogin.clientId,
    // Must equal an authorized redirect URI of the Google OAuth client. Built on
    // config.issuer for the same reason as the /consent redirect (RFC 9700 §2.1).
    loginUri: new URL('/login/google', config.issuer).toString(),
    nonce,
    // OIDC Core 1.0 §3.1.2.1: pass login_hint on so Google can preselect the account.
    loginHint: transaction.loginHint,
    hostedDomain: typeof googleLogin.hostedDomain === 'string' ? googleLogin.hostedDomain : undefined,
  });
}

/**
 * EXTENSION (google-login): run the callback checks and map the Google account
 * to an OP subject. Returns the error to show on failure so a failed Google
 * callback is never redirected to a client — until the nonce is verified the
 * OP cannot tell whose transaction this is.
 */
async function verifyGoogleLoginCallback(
  c: any,
  googleLogin: GoogleLoginConfig,
): Promise<{ transactionId: string; subject: string } | LoginError> {
  const nonceStore = c.get('googleLoginNonceStore') ?? defaultGoogleLoginNonceStore;
  const verifier = c.get('googleIdTokenVerifier');
  const accountResolver = c.get('googleAccountResolver') ?? {
    resolveSubject: async (account: GoogleIdTokenPayload) =>
      (await userStore.linkGoogleAccount(account)).sub,
  };
  try {
    // Double Submit Cookie -> google-auth-library verification -> nonce lookup,
    // in the order Google's server-side verification guide prescribes.
    const login = await handleGoogleLoginRedirect({
      params: await c.req.parseBody(),
      cookieHeader: c.req.header('Cookie') ?? null,
      clientId: googleLogin.clientId,
      verifier,
      nonceStore,
      hostedDomain: googleLogin.hostedDomain,
      requireVerifiedEmail: googleLogin.requireVerifiedEmail,
    });
    const subject = await resolveGoogleLoginSubject(login.account, accountResolver);
    return { transactionId: login.transactionId, subject };
  } catch (error) {
    if (!(error instanceof GoogleLoginError)) throw error;
    return {
      kind: 'error',
      error: error.code,
      errorDescription: error.message,
      statusCode: error.httpStatusCode,
    };
  }
}
`
    : '';
  const googleTransactionNote = `
 *
 * The transaction cookie does not come along: Google's POST is a cross-site
 * navigation, so the browser withholds SameSite=Lax cookies. The single-use
 * nonce stands in for it - it was issued on the login page, which only the
 * browser holding the cookie could load. The consent step that follows is a
 * plain navigation again and reads the cookie as usual.`;
  const googleLoginOutcome = features.googleLogin
    ? `
/** What the Google login callback decided; pages/login.ts turns it into HTTP. */
export type GoogleLoginOutcome =
  | LoginError
  /** config.googleLogin is not set: the callback does not exist (404). */
  | { kind: 'not_configured' }
  /** Signed in: the OP session cookie(s) to set, then continue to the consent step. */
  | { kind: 'authenticated'; cookies: string[] };
`
    : '';
  const googleLoginFunction = features.googleLogin
    ? `
/**
 * EXTENSION (google-login) — the Google login callback (login_uri), POST /login/google.
 *
 * Sign in with Google (redirect mode) posts the ID token here once the user
 * picks an account. After the callback checks, this continues exactly like a
 * successful password login: same session cookie, same consent hand-off.${googleTransactionNote}
 */
export async function completeGoogleLogin(c: any): Promise<GoogleLoginOutcome> {
  const config = c.get('config') ?? defaultProviderConfig;
  if (!config.googleLogin) {
    return { kind: 'not_configured' };
  }

  const verified = await verifyGoogleLoginCallback(c, config.googleLogin);
  if ('kind' in verified) return verified;
  const { transactionId, subject } = verified;

  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  let transaction: AuthTransaction;
  try {
    transaction = await getAuthTransaction(transactionId, transactionStore);
  } catch (error) {
    return transactionErrorOutcome(error);
  }

  // prompt=login / select_account requires fresh authentication: discard any
  // existing transaction handoff AND browser session (OIDC Core 1.0 Section 3.1.2.1).
  const loginPromptValues = transaction.prompt?.trim().split(/\\s+/).filter(Boolean) ?? [];
  if (loginPromptValues.includes('login') || loginPromptValues.includes('select_account')) {
    await authSessionStore.delete(transactionId);
    const existingSessionId = parseSessionId(c.req.header('Cookie') ?? null);
    if (existingSessionId) await browserSessionStore.delete(existingSessionId);
  }

  const authTime = Math.floor(Date.now() / 1000);

  // Establish the browser (OP) session and the per-transaction handoff exactly
  // as the password login does (OIDC Core 1.0 Section 3.1.2.3).
  const sessionId = await generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject, authTime });
  await authSessionStore.set(transactionId, { subject, authTime, sessionId });

  return { kind: 'authenticated', cookies: [buildSessionCookie(sessionId)] };
}
`
    : '';
  return `/**
 * Login step (API layer: logic only).
 *
 * Everything the login screen has to decide lives here as plain functions:
 * finding the transaction through the transaction cookie, the csrf_token
 * check, the credential check, the lockout, the OP session cookie and the
 * hand-off to the consent step. None of them builds a Response — each returns
 * an outcome, and pages/login.ts turns that outcome into a screen or a
 * redirect. The UI can therefore be changed without touching this file.
 */
import {
  getAuthTransaction,
  validateCsrfToken,
  handleLoginFailure,
  generateRandomString,
  AuthTransactionError,
  type AuthTransaction,
} from '${corePkg}';${googleLoginImports}
import {
  transactionStore as defaultTransactionStore,
  authSessionStore as defaultAuthSessionStore,
  browserSessionStore as defaultBrowserSessionStore,
  buildSessionCookie,
  parseSessionId,
  parseTransactionId,
  isSameOriginFormPost,
  CROSS_ORIGIN_FORM_POST_MESSAGE,${googleStoreImport}
  userStore,
} from '../store.js';${googleConfigImport}

/** What the login form needs: prepared for GET /login and again after a failed attempt. */
export interface LoginScreen {
  kind: 'screen';
  /**
   * Must be posted back as the csrf_token field. It is the only value the form
   * carries about the transaction: the transaction itself travels in the
   * transaction cookie, and POST /login accepts the token only for that one.
   */
  csrfToken: string;
  /**
   * OIDC Core 1.0 §3.1.2.1 login_hint: untrusted external value the OP MAY use
   * to pre-fill the login form.
   */
  loginHint?: string;${googleScreenField}
}

/** A failure the OP shows on its own error page (never redirected to the client). */
export interface LoginError {
  kind: 'error';
  error: string;
  errorDescription?: string;
  statusCode: number;
}

/** What POST /login decided; pages/login.ts turns it into HTTP. */
export type LoginOutcome =
  | LoginError
  /** handleLoginFailure() locked the transaction: no further attempt is accepted (429). */
  | { kind: 'locked_out' }
  /** Wrong credentials: show the form again with the attempts left. */
  | { kind: 'invalid_credentials'; screen: LoginScreen; remainingAttempts: number }
  /** Signed in: the OP session cookie(s) to set, then continue to the consent step. */
  | { kind: 'authenticated'; cookies: string[] };
${googleLoginOutcome}
/** The fields of the login form. */
export interface LoginSubmission {
  csrfToken: string;
  username: string;
  password: string;
}

/**
 * The OP's own error page for a transaction that cannot continue: unknown,
 * finished or expired (400), or a csrf_token that does not belong to it (403).
 * It is never redirected to the client's redirect_uri: until the transaction
 * and its csrf_token check out, the OP cannot tell whose request this is.
 */
function transactionErrorOutcome(error: unknown): LoginError {
  if (!(error instanceof AuthTransactionError)) throw error;
  return { kind: 'error', error: error.message, statusCode: error.httpStatusCode };
}

/**
 * The transaction this browser is in the middle of: the id from the transaction
 * cookie /authorize set (buildTransactionCookie() in store.ts), loaded from the
 * store. Returns the error to show instead when there is none.
 */
async function loadTransaction(
  c: any,
): Promise<{ transactionId: string; transaction: AuthTransaction } | LoginError> {
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
 * Refuse a login form POST that the browser says came from anywhere but the
 * OP's own pages (403, never redirected). See isSameOriginFormPost() in store.ts.
 */
function rejectCrossOriginFormPost(c: any): LoginError | undefined {
  const sameOrigin = isSameOriginFormPost(
    { origin: c.req.header('Origin') ?? null, secFetchSite: c.req.header('Sec-Fetch-Site') ?? null },
    c.get('config').issuer,
  );
  return sameOrigin ? undefined : { kind: 'error', error: CROSS_ORIGIN_FORM_POST_MESSAGE, statusCode: 403 };
}
${googleLoginHelpers}
/** Describe the form for a transaction (the shared part of GET and a failed POST). */
async function describeLoginScreen(
${screenContextParam}  transaction: AuthTransaction,
): Promise<LoginScreen> {
  return {
    kind: 'screen',
    csrfToken: transaction.csrfToken,
    loginHint: transaction.loginHint,${googleScreenValue}
  };
}

/**
 * GET /login: load the transaction this browser's cookie names and describe the
 * form, or the error to show instead when there is none.
 */
export async function prepareLogin(c: any): Promise<LoginScreen | LoginError> {
  const loaded = await loadTransaction(c);
  if ('kind' in loaded) return loaded;
  return describeLoginScreen(${preparedScreenArgs});
}

/**
 * POST /login: check the credentials and, on success, establish the OP session.
 */
export async function submitLogin(c: any, input: LoginSubmission): Promise<LoginOutcome> {
  const { csrfToken, username, password } = input;

  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;
  const browserSessionStore = c.get('browserSessionStore') ?? defaultBrowserSessionStore;
  const authenticateUser =
    c.get('authenticateUser') ??
    ((u: string, p: string) => userStore.authenticate(u, p));

  // First the browser's own statement of where the form was submitted from
  // (isSameOriginFormPost() in store.ts): independent of the cookie and the
  // csrf_token, so a forged POST is stopped even if both were planted.
  const sameOriginError = rejectCrossOriginFormPost(c);
  if (sameOriginError) return sameOriginError;

  // The cookie says which transaction this browser is in; the csrf_token says
  // the submission came from the form the OP rendered for exactly that one.
  const loaded = await loadTransaction(c);
  if ('kind' in loaded) return loaded;
  const { transactionId, transaction } = loaded;
  try {
    validateCsrfToken(transaction, csrfToken);
  } catch (error) {
    return transactionErrorOutcome(error);
  }

  // Authenticate user
  const user = await authenticateUser(username, password);
  if (!user) {
    const failureResult = await handleLoginFailure(
      transactionId,
      transaction,
      transactionStore,
    );
    if (!failureResult.canRetry) {
      return { kind: 'locked_out' };
    }
    return {
      kind: 'invalid_credentials',
      screen: await describeLoginScreen(${screenContextArg}transaction),
      remainingAttempts: failureResult.maxAttempts - failureResult.failedAttempts,
    };
  }

  // prompt=login (and prompt=select_account in Phase 1) requires fresh
  // authentication: discard any existing transaction handoff AND browser session.
  // OIDC Core 1.0 Section 3.1.2.1 — prompt is a space-delimited list, use includes()
  const loginPromptValues = transaction.prompt?.trim().split(/\\s+/).filter(Boolean) ?? [];
  if (loginPromptValues.includes('login') || loginPromptValues.includes('select_account')) {
    await authSessionStore.delete(transactionId);
    const existingSessionId = parseSessionId(c.req.header('Cookie') ?? null);
    if (existingSessionId) await browserSessionStore.delete(existingSessionId);
  }

  const authTime = Math.floor(Date.now() / 1000);

  // Establish a persistent browser (OP) session; its cookie travels with the
  // answer so SSO / prompt=none / max_age work on subsequent authorization
  // requests (OIDC Core 1.0 Section 3.1.2.3).
  const sessionId = await generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject: user.sub, authTime });

  // Store authenticated subject for the consent step (per-transaction handoff).
  // sessionId も渡すのは online refresh token のため。consent 経由で発行する認可
  // コードにこのセッションを引き継ぎ、ログアウトで使えなくなる RT を作る。
  await authSessionStore.set(transactionId, {
    subject: user.sub,
    authTime,
    sessionId,
  });

  return { kind: 'authenticated', cookies: [buildSessionCookie(sessionId)] };
}
${googleLoginFunction}`;
}

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
  // The scope policy needs the auth session, which is keyed by the transaction id.
  const consentPrepareBindings = customScopesDeclared ? 'transactionId, transaction' : 'transaction';
  const consentDisplayScopes = customScopesDeclared
    ? 'displayedScopes'
    : "transaction.scope.split(' ').filter(Boolean)";
  const consentGrantedScope = customScopesDeclared
    ? `
  // Apply the scope policy (resolveGrantableScopes in scopes.ts — the place to
  // write per-user filtering). A dropped scope narrows the grant rather than
  // failing the request: RFC 6749 §3.3 lets the authorization server issue a
  // narrower scope, and the token response reports what was granted.
  const grantedScope = await resolveGrantableScopes(
    transaction.scope.split(' ').filter(Boolean),
    session.subject,
  );`
    : `  const grantedScope = transaction.scope.split(' ').filter(Boolean);`;
  // The transaction is over once a decision is recorded: its cookie travels back
  // cleared so the browser does not keep pointing at a finished transaction.
  const finishedCookies = '[buildClearedTransactionCookie()]';
  // EXPERIMENTAL (JARM): the consent step is where the interactive flow produces
  // its authorization response, so it must answer in the mode the authorize step
  // recorded on the transaction. Every interpolation collapses to the current
  // output when the jarm feature is off.
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

/**
 * EXPERIMENTAL — JARM Section 2.3.1: deliver the authorization response as the
 * single \`response\` query parameter holding a signed JWT. Without a JARM
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
`
    : '';
  const consentDenyResponse = features.jarm
    ? `  if (action === 'deny') {
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
      cookies: ${finishedCookies},
    };
  }`
    : `  if (action === 'deny') {
    const redirectUrl = new URL(transaction.redirectUri);
    redirectUrl.searchParams.set('error', 'access_denied');
    if (transaction.state) {
      redirectUrl.searchParams.set('state', transaction.state);
    }
    redirectUrl.searchParams.set('iss', issuer);
    await transactionStore.delete('auth_txn:' + transactionId);
    await authSessionStore.delete(transactionId);
    return { kind: 'authorization_response', location: redirectUrl.toString(), cookies: ${finishedCookies} };
  }`;
  const consentSuccessResponse = features.jarm
    ? `  // Back to the client with the authorization code
  return {
    kind: 'authorization_response',
    location: await buildConsentRedirect(resolveJarmResponse(c, transaction), responseParams.redirectUri, {
      code: authCodeData.code,
      state: responseParams.state,
    }, issuer),
    cookies: ${finishedCookies},
  };`
    : `  // Back to the client with the authorization code
  const redirectUrl = new URL(responseParams.redirectUri);
  redirectUrl.searchParams.set('code', authCodeData.code);
  if (responseParams.state) {
    redirectUrl.searchParams.set('state', responseParams.state);
  }
  redirectUrl.searchParams.set('iss', issuer);
  return { kind: 'authorization_response', location: redirectUrl.toString(), cookies: ${finishedCookies} };`;
  return `/**
 * Consent step (API layer: logic only).
 *
 * Everything the consent screen has to decide lives here as plain functions:
 * finding the transaction through the transaction cookie, the csrf_token
 * check, the scope policy, the authorization decision, the authorization code,
 * the consent record and the authorization response URL (RFC 6749 §4.1.2 /
 * RFC 9207 iss / JARM). None of them builds a Response — each returns an
 * outcome, and pages/consent.ts turns that outcome into a screen or a
 * redirect. The UI can therefore be changed without touching this file.
 */
import {
  getAuthTransaction,
  validateCsrfToken,
  completeAuthTransaction,
  createAuthorizationCode,
  AuthTransactionError,
  type AuthTransaction,${jarmConsentCoreImports}
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
 * The transaction this browser is in the middle of: the id from the transaction
 * cookie /authorize set (buildTransactionCookie() in store.ts), loaded from the
 * store. Returns the error to show instead when there is none.
 */
async function loadTransaction(
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
 * Refuse a consent form POST that the browser says came from anywhere but the
 * OP's own pages (403, never redirected). See isSameOriginFormPost() in store.ts.
 */
function rejectCrossOriginFormPost(c: any): ConsentError | undefined {
  const sameOrigin = isSameOriginFormPost(
    { origin: c.req.header('Origin') ?? null, secFetchSite: c.req.header('Sec-Fetch-Site') ?? null },
    c.get('config').issuer,
  );
  return sameOrigin ? undefined : { kind: 'error', error: CROSS_ORIGIN_FORM_POST_MESSAGE, statusCode: 403 };
}
${jarmConsentHelpers}
/**
 * GET /consent: load the transaction this browser's cookie names and describe
 * the form, or the error to show instead when there is none.
 */
export async function prepareConsent(c: any): Promise<ConsentScreen | ConsentError> {
  const loaded = await loadTransaction(c);
  if ('kind' in loaded) return loaded;
  const { ${consentPrepareBindings} } = loaded;
${consentGetScopeResolution}  return {
    kind: 'screen',
    csrfToken: transaction.csrfToken,
    scopes: ${consentDisplayScopes},
    clientId: transaction.clientId,
  };
}

/**
 * POST /consent: record the decision and build the authorization response.
 */
export async function submitConsent(c: any, input: ConsentSubmission): Promise<ConsentOutcome> {
  const { csrfToken, action } = input;

  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const authCodeStore = c.get('authCodeStore') ?? defaultAuthCodeStore;
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;

  // Checked before any decision is acted on: this step mints the authorization
  // code, so neither an approval nor a denial may come from anywhere else.
  // First the browser's own statement of where the form was submitted from
  // (isSameOriginFormPost() in store.ts): independent of the cookie and the
  // csrf_token, so a forged POST is stopped even if both were planted.
  const sameOriginError = rejectCrossOriginFormPost(c);
  if (sameOriginError) return sameOriginError;

  // The cookie says which transaction this browser is in; the csrf_token says
  // the decision came from the form the OP rendered for exactly that one.
  const loaded = await loadTransaction(c);
  if ('kind' in loaded) return loaded;
  const { transactionId, transaction } = loaded;
  try {
    validateCsrfToken(transaction, csrfToken);
  } catch (error) {
    return transactionErrorOutcome(error);
  }

  // RFC 9207 §2: include the issuer identifier on every authorization response
  // (success and error) so clients can pin the issuer that produced the response.
  const config = c.get('config');
  const issuer = config.issuer;

${consentDenyResponse}

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
${consentGrantedScope}

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

${consentSuccessResponse}
}
`;
}

export function applyTemplate(
  _corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  db = false,
): string {
  const storageParts = honoStorageTemplateParts(db);
  const introspectionImport = features.introspection
    ? `import { introspectionApp } from './routes/introspection.js';\n`
    : '';
  const revocationImport = features.revocation
    ? `import { revocationApp } from './routes/revocation.js';\n`
    : '';
  const introspectionCors = features.introspection
    ? `  app.use('/introspect', protectedCors);\n`
    : '';
  const revocationCors = features.revocation
    ? `  app.use('/revoke', protectedCors);\n`
    : '';
  const introspectionMount = features.introspection
    ? `  app.route('/introspect', introspectionApp);\n`
    : '';
  const revocationMount = features.revocation
    ? `  app.route('/revoke', revocationApp);\n`
    : '';
  // EXPERIMENTAL (RFC 9126): the PAR endpoint is a back-channel, client-authenticated
  // POST endpoint, so it gets the same CORS policy as /token.
  const parImport = features.par
    ? `import { parApp } from './routes/par.js';\n`
    : '';
  const parCors = features.par
    ? `  app.use('/par', protectedCors);\n`
    : '';
  const parMount = features.par
    ? `  app.route('/par', parApp);\n`
    : '';
  const parStorageContext = features.par
    ? `    c.set('parStore', parStore);\n`
    : '';
  const parStoreImport = features.par
    ? `  parStore,\n`
    : '';
  // EXPERIMENTAL (RFC 8628): the device authorization endpoint is a back-channel,
  // client-authenticated POST endpoint, so it gets the same CORS policy as /token.
  // The verification UI (/device...) is reached by direct browser navigation, so
  // it needs no CORS headers — the same treatment as /login and /consent.
  const deviceImport = features.deviceAuthorizationGrant
    ? `import { deviceAuthorizationApp } from './routes/device-authorization.js';
import { devicePage } from './pages/device.js';\n`
    : '';
  const deviceCors = features.deviceAuthorizationGrant
    ? `  app.use('/device_authorization', protectedCors);\n`
    : '';
  const deviceMount = features.deviceAuthorizationGrant
    ? `  app.route('/device_authorization', deviceAuthorizationApp);
  app.route('/device', devicePage);\n`
    : '';
  const deviceStorageContext = features.deviceAuthorizationGrant
    ? `    c.set('deviceAuthorizationStore', deviceAuthorizationStore);\n`
    : '';
  const deviceStoreImport = features.deviceAuthorizationGrant
    ? `  deviceAuthorizationStore,\n`
    : '';
  // EXPERIMENTAL (CIBA Core 1.0): same policy split as createApp — the
  // back-channel endpoint shares the /token CORS policy, the authentication
  // device UI is plain browser navigation.
  const cibaImport = features.ciba
    ? `import { backchannelAuthenticationApp } from './routes/backchannel-authentication.js';
import { cibaPage } from './pages/ciba.js';\n`
    : '';
  const cibaCors = features.ciba
    ? `  app.use('/backchannel_authentication', protectedCors);\n`
    : '';
  const cibaMount = features.ciba
    ? `  app.route('/backchannel_authentication', backchannelAuthenticationApp);
  app.route('/ciba', cibaPage);\n`
    : '';
  const cibaStorageContext = features.ciba
    ? `    c.set('cibaAuthenticationRequestStore', cibaAuthenticationRequestStore);
    c.set('cibaLoginTransactionStore', cibaLoginTransactionStore);
    c.set('cibaUserResolver', options.cibaUserResolver ?? (async (loginHint: string) => {
      const claims = await stores.userStore.getClaims(loginHint);
      return claims ? { subject: claims.sub } : null;
    }));`
    : '';
  const cibaStoreImport = features.ciba
    ? `  cibaAuthenticationRequestStore,
  cibaLoginTransactionStore,\n`
    : '';
  const cibaOptionsField = features.ciba
    ? `  /**
   * EXPERIMENTAL (CIBA Core 1.0 §7.1): resolve a login_hint to the subject the
   * authentication request is for. Defaults to treating the hint as a username
   * of the configured user store. Return null when no user matches.
   */
  cibaUserResolver?: (
    loginHint: string,
  ) => Promise<{ subject: string } | null> | { subject: string } | null;
`
    : '';
  // EXPERIMENTAL (RP-Initiated Logout 1.0): the end_session_endpoint and its
  // confirmation screen are reached by direct browser navigation, so they need
  // no CORS headers — the same treatment as /login and /consent. The feature
  // adds no store: the session store and the id_token_hint JWKS provider are
  // already wired for every build.
  const logoutImport = features.rpInitiatedLogout
    ? `import { logoutPage } from './pages/logout.js';\n`
    : '';
  const logoutMount = features.rpInitiatedLogout
    ? `  app.route('/logout', logoutPage);\n`
    : '';
  // EXTENSION (google-login): the Google login callback needs the nonce store,
  // the ID token verifier (google-auth-library by default) and the resolver that
  // maps a verified Google account to an OP subject. The default resolver links
  // the account through the user store (just-in-time provisioning), so a custom
  // storage option is honored without extra wiring.
  const googleLoginImport = features.googleLogin
    ? `import {
  getDefaultGoogleIdTokenVerifier,
  type GoogleAccountResolver,
  type GoogleIdTokenPayload,
  type GoogleIdTokenVerifier,
} from '${GOOGLE_LOGIN_PACKAGE}';\n`
    : '';
  const googleLoginStorageContext = features.googleLogin
    ? `    c.set('googleLoginNonceStore', stores.googleLoginNonceStore);
    c.set('googleIdTokenVerifier', options.googleIdTokenVerifier ?? getDefaultGoogleIdTokenVerifier());
    c.set('googleAccountResolver', options.googleAccountResolver ?? {
      resolveSubject: async (account: GoogleIdTokenPayload) =>
        (await stores.userStore.linkGoogleAccount(account)).sub,
    });\n`
    : '';
  const googleLoginOptionsFields = features.googleLogin
    ? `  /**
   * EXTENSION (google-login): verifier for the ID token Google posts to
   * /login/google. Defaults to google-auth-library (OAuth2Client.verifyIdToken)
   * with a process-wide certificate cache; inject a custom one for tests or a
   * proxied environment.
   */
  googleIdTokenVerifier?: GoogleIdTokenVerifier;
  /**
   * EXTENSION (google-login): map a verified Google account to the OP subject.
   * Defaults to just-in-time provisioning through the user store
   * (userStore.linkGoogleAccount), keyed by the Google \`sub\`.
   */
  googleAccountResolver?: GoogleAccountResolver;
`
    : '';
  const refreshStorageContext = features.refreshToken
    ? `    c.set('refreshTokenResolver', storeResolvers.refreshTokenResolver);
    c.set('authenticationSessionResolver', storeResolvers.authenticationSessionResolver);\n`
    : '';
  const introspectionStorageContext = features.introspection
    ? `    c.set('introspectionAccessTokenResolver', storeResolvers.introspectionAccessTokenResolver);
    c.set('introspectionRefreshTokenResolver', storeResolvers.introspectionRefreshTokenResolver);\n`
    : '';
  const revocationStorageContext = features.revocation
    ? `    c.set('revocationResolvers', storeResolvers.revocationResolvers);\n`
    : '';
  const methodGuard = oidcMethodGuardTemplate(features);
  return `import type { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authorizePage } from './pages/authorize.js';
import { tokenApp } from './routes/token.js';
import { userinfoApp } from './routes/userinfo.js';
${introspectionImport}${revocationImport}${parImport}${deviceImport}${cibaImport}${logoutImport}import { jwksApp } from './routes/jwks.js';
import { discoveryApp } from './routes/discovery.js';
import { loginPage } from './pages/login.js';
import { consentPage } from './pages/consent.js';
import {
  createInMemoryClientResolver,
  createProviderConfig,
  type ProviderConfig,
} from './config.js';
import {
  createStoreResolvers,
} from './resolvers.js';
import {
${storageParts.defaultStoresImport}${parStoreImport}${deviceStoreImport}${cibaStoreImport}  type ProviderStores,
  type ProviderStoresFactory,
} from './store.js';
import { createViews, type Views } from './views.js';
${storageParts.dbImports}${googleLoginImport}import {
  assertHasRs256Key,
  assertKeyStrength,
  assertKidStrategyConsistent,
  signingKeysToJwkSet,
} from '${_corePkg}';
import type {
  SigningKey,
  SigningKeyProvider,
  ClientResolver,
  TokenClientResolver,
  AcrResolver,
  JwkSet,
  SessionResolver,
  ConsentResolver,
} from '${_corePkg}';

/**
 * CORS の許可 origin。
 * - '*' (デフォルト) または string / string[]: cors() の origin オプションに直接渡される
 * - browser-based クライアントで Authorization ヘッダや form body を使う場合は許可必須 (OAuth 2.1 §4.2)
 */
export type CorsOrigins = string | string[];

export interface ApplyOidcOptions {
  config?: Partial<ProviderConfig>;
  /**
   * Primary signing key provider. getSigningKeys() returns the registered
   * keys: the first one signs access tokens (JWT format), and every one is
   * published at the JWKS endpoint, so keep a rotated-out key after the new one
   * until the tokens it signed expire. Also used for ID Token / UserInfo
   * signing when their dedicated providers are not configured.
   * Must load keys from your secret store (env var, KV, D1, etc.).
   * Use createCachedSigningKeyProvider() to refresh the keys periodically.
   */
  signingKeyProvider: SigningKeyProvider;
  /**
   * Optional ID Token signing key provider.
   * If omitted, signingKeyProvider is used.
   * Useful when id_token_signed_response_alg differs from the access token
   * algorithm, or when you want to rotate ID Token keys independently.
   */
  idTokenSigningKeyProvider?: SigningKeyProvider;
  /**
   * Optional UserInfo JWT signing key provider.
   * If omitted, signingKeyProvider is used.
   * Useful when userinfo_signed_response_alg differs from other signing keys
   * (OIDC Core 1.0 Section 5.3.2).
   */
  userinfoSigningKeyProvider?: SigningKeyProvider;
  clientResolver?: ClientResolver;
  tokenClientResolver?: TokenClientResolver;
  /**
   * Session resolver used for SSO / prompt=none / max_age
   * (OIDC Core 1.0 Section 3.1.2.1 / 3.1.2.3).
   * Defaults to the cookie-based browser session resolver in resolvers.ts.
   */
  sessionResolver?: SessionResolver;
  /**
   * Consent resolver used by prompt=none to confirm prior consent without UI
   * (OIDC Core 1.0 Section 3.1.2.1).
   * Defaults to the in-memory consent store resolver in resolvers.ts.
   */
  consentResolver?: ConsentResolver;
  /** ${storageParts.storageDoc} */
  storage?: ProviderStores | ProviderStoresFactory;
  /**
   * acr / amr resolver (OIDC Core 1.0 §2 / §12.1).
   * Host application が認証ポリシーに合わせて acr / amr を返す。
   * 未指定の場合 ID Token に acr / amr クレームは含まれない（T-009 hold 相当）。
   */
  acrResolver?: AcrResolver;
  /**
   * id_token_hint 検証用に OP の JWKS を返すプロバイダ。
   * authorize エンドポイントで id_token_hint パラメータを受け取った場合、
   * その JWT の署名を検証するために使用される (OIDC Core 1.0 §3.1.2.1)。
   * 未指定の場合、id_token_hint を含む prompt=none 認可リクエストは
   * login_required で拒否される。
   */
  jwksProvider?: () => Promise<JwkSet> | JwkSet;
  /**
   * CORS で許可する origin。
   * - 未指定: '*' (=ワイルドカード)
   * - 文字列または配列: そのまま hono/cors の origin に渡す
   *
   * Token / UserInfo / Introspection / Revocation エンドポイントに適用される。
   * Discovery / JWKS は仕様上常に '*' 固定 (OIDC Discovery / RFC 8414 で公開資産扱い)。
   */
${cibaOptionsField}${googleLoginOptionsFields}  corsOrigins?: CorsOrigins;
  /**
   * Custom UI for the login / consent / error pages.
   * Provide any subset; omitted pages fall back to the default views.
   * Inject your own UI here instead of editing views.ts.
   */
  views?: Partial<Views>;
}

export function validateSigningKeySet(
  keys: readonly SigningKey[],
  requireRs256 = false,
): void {
  // The first key of a set signs new tokens, so a set needs at least one key.
  if (keys.length === 0) {
    throw new Error('Signing key set must contain at least one key');
  }
  assertKeyStrength(keys);
  assertKidStrategyConsistent(keys);
  if (requireRs256) {
    assertHasRs256Key(keys.map((key) => key.privateKey));
  }
}

${methodGuard}

/**
 * Apply the OpenID Connect Provider routes and middleware to an existing Hono app.
 * Call this function to add OIDC provider functionality to your application.
 *
 * @example
 * import { Hono } from 'hono';
 * import { applyOidc } from './oidc-provider/apply.js';
 *
 * const app = new Hono();
 * app.get('/', (c) => c.text('Hello World'));
 * applyOidc(app, { signingKeyProvider: yourProvider });
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyOidc(app: Hono<any>, options: ApplyOidcOptions): void {
  // CORS middleware (OAuth 2.1 §4.2): browser-based client が Token/UserInfo/Introspect/Revoke
  // を呼べるように Access-Control-Allow-Origin を返す。preflight (OPTIONS) も自動で処理される。
  // Discovery / JWKS は常に '*' (公開資産)。
  const corsOrigins = options.corsOrigins ?? '*';
  const protectedCors = cors({
    origin: corsOrigins,
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  const publicCors = cors({
    origin: '*',
    allowMethods: ['GET', 'OPTIONS'],
    maxAge: 600,
  });
  app.use('/token', protectedCors);
  app.use('/userinfo', protectedCors);
${introspectionCors}${revocationCors}${parCors}${deviceCors}${cibaCors}  app.use('/.well-known/openid-configuration', publicCors);
  app.use('/.well-known/jwks.json', publicCors);
  // CORS must run first so OPTIONS preflights are answered before method enforcement.
  app.use('*', enforceOidcEndpointMethod);

  // Store runtime dependencies for use by route handlers.
  app.use('*', async (c, next) => {
    // T-022: each provider returns its registered key set. The first key of a
    // set signs new tokens, and every key is published at the JWKS endpoint so
    // rotated-out and alternate-alg keys stay verifiable.
    let signingKeys;
    let idTokenSigningKeys;
    let userinfoSigningKeys;
    try {
      signingKeys = await options.signingKeyProvider.getSigningKeys();
      // Each purpose-specific provider falls back to the primary one.
      const idProvider = options.idTokenSigningKeyProvider ?? options.signingKeyProvider;
      idTokenSigningKeys = await idProvider.getSigningKeys();
      const uiProvider = options.userinfoSigningKeyProvider ?? options.signingKeyProvider;
      userinfoSigningKeys = await uiProvider.getSigningKeys();
      validateSigningKeySet(signingKeys);
      validateSigningKeySet(idTokenSigningKeys, true);
      validateSigningKeySet(userinfoSigningKeys);
    } catch {
      return c.json({ error: 'server_error', error_description: 'Failed to load signing key' }, 503);
    }
    const clientResolver =
      options.clientResolver ?? createInMemoryClientResolver();
    const stores = await resolveProviderStores(options.storage, c);
    const storeResolvers = createStoreResolvers(stores);

    // T-022: registered key sets per purpose.
    c.set('signingKeys', signingKeys);
    c.set('idTokenSigningKeys', idTokenSigningKeys);
    c.set('userinfoSigningKeys', userinfoSigningKeys);

    c.set('config', createProviderConfig(options.config));
    c.set('clientResolver', clientResolver);
    c.set('tokenClientResolver', options.tokenClientResolver ?? clientResolver);
    c.set('transactionStore', stores.transactionStore);
    c.set('authCodeStore', stores.authCodeStore);
    c.set('accessTokenStore', stores.accessTokenStore);
    c.set('refreshTokenStore', stores.refreshTokenStore);
    c.set('authSessionStore', stores.authSessionStore);
    c.set('browserSessionStore', stores.browserSessionStore);
    c.set('authenticateUser', (username: string, password: string) =>
      stores.userStore.authenticate(username, password));
    c.set('authCodeResolver', storeResolvers.authorizationCodeResolver);
    c.set('accessTokenResolver', storeResolvers.accessTokenResolver);
    c.set('userClaimsResolver', storeResolvers.userClaimsResolver);
${refreshStorageContext}${introspectionStorageContext}${revocationStorageContext}${parStorageContext}${deviceStorageContext}${cibaStorageContext}${googleLoginStorageContext}
    // T-015: acr / amr resolver (optional; undefined preserves T-009 hold behavior).
    if (options.acrResolver) {
      c.set('acrResolver', options.acrResolver);
    }
    // T-017 / P1: id_token_hint 検証用 JWKS プロバイダ。未指定なら OP 自身の
    // ID Token 署名鍵セットを既定として使い、OP が発行した ID Token を hint として
    // 検証できるようにする（OIDC Core 1.0 §3.1.2.2）。明示指定があれば優先。
    c.set('jwksProvider', options.jwksProvider ?? (() => signingKeysToJwkSet(idTokenSigningKeys)));
    // P1: default cookie-based session + consent resolvers so prompt=none /
    // max_age / SSO work out of the box (OIDC Core 1.0 Section 3.1.2.1 / 3.1.2.3).
    c.set('sessionResolver', options.sessionResolver ?? storeResolvers.sessionResolver);
    c.set('consentResolver', options.consentResolver ?? storeResolvers.consentResolver);
    // Inject custom UI (login / consent / error) merged over the defaults.
    c.set('views', createViews(options.views));
    await next();
  });

  // Browser-facing surfaces are mounted from pages/: every GET and POST of a
  // screen lives there, and the logic they call is in routes/.
  app.route('/authorize', authorizePage);
  app.route('/token', tokenApp);
  app.route('/userinfo', userinfoApp);
${introspectionMount}${revocationMount}${parMount}${deviceMount}${cibaMount}${logoutMount}  app.route('/.well-known/jwks.json', jwksApp);
  app.route('/.well-known/openid-configuration', discoveryApp);
  app.route('/login', loginPage);
  app.route('/consent', consentPage);
}

async function resolveProviderStores(
  storage: ApplyOidcOptions['storage'],
  context: any,
): Promise<ProviderStores> {
  if (!storage) return ${storageParts.defaultStores};
  return typeof storage === 'function' ? storage(context) : storage;
}
`;
}

export function introspectionRouteTemplate(
  corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  // EXPERIMENTAL (RFC 9701): the JWT introspection response only changes the
  // format of the answer to a caller that explicitly asked for it via Accept.
  // Every interpolation below collapses to the current output when the
  // jwt-introspection-response feature is off, so the default generation is
  // unchanged byte for byte.
  const introspectionJwtCoreImports = features.jwtIntrospectionResponse
    ? `
  selectSigningKeyByAlg,
  type SigningKey,`
    : '';
  const introspectionJwtImports = features.jwtIntrospectionResponse
    ? `
import {
  TOKEN_INTROSPECTION_JWT_MEDIA_TYPE,
  acceptsIntrospectionJwt,
  createIntrospectionResponseJwt,
  restrictIntrospectionResponseToCaller,
} from '${EXPERIMENTAL_PACKAGE}/jwt-introspection-response';`
    : '';
  const introspectionJwtResponseBranch = features.jwtIntrospectionResponse
    ? `    // EXPERIMENTAL — RFC 9701 §4 / §5: a caller whose Accept header names
    // application/token-introspection+jwt receives the introspection response
    // as a signed JWT. Any other request (no Accept, application/json, a
    // wildcard) is answered exactly as before, and the branch sits AFTER client
    // authentication and token resolution so the Accept header can never
    // bypass either (§8.2 downgrade prevention).
    if (acceptsIntrospectionJwt(c.req.header('Accept'))) {
      // RFC 9701 §3 / §5: before the response leaves as a signed assertion its
      // members are restricted to what the authenticated caller may see — a
      // caller that is neither the client the token was issued to nor listed in
      // its aud gets { active: false }, indistinguishable from an unknown token.
      const restrictedResponse = restrictIntrospectionResponseToCaller(
        response,
        authenticatedClientId,
      );
      // RFC 9701 §6: alg is pinned to RS256 (the default for a client that
      // registered no introspection_signed_response_alg). The first key of the
      // general-purpose set is not guaranteed to be RS256 — a SigningKeyProvider
      // may legitimately put an ES256 key first in an RS256 + ES256 set — so the
      // key is picked by alg from the set. Its public half is published at
      // /.well-known/jwks.json under the same kid. selectSigningKeyByAlg throws
      // when no RS256 key is registered, which surfaces as a server_error below
      // (a configuration mistake) rather than as an unverifiable introspection
      // response.
      const introspectionSigningKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
      const introspectionSigningKey = selectSigningKeyByAlg(introspectionSigningKeys, 'RS256');
      const responseJwt = await createIntrospectionResponseJwt({
        issuer: c.get('config').issuer,
        audience: authenticatedClientId,
        introspection: restrictedResponse,
        signingKey: introspectionSigningKey,
      });
      // RFC 9701 §5: the success response is the compact JWS itself under its
      // own media type. c.body (unlike c.text, which forces text/plain) keeps
      // the explicitly set Content-Type, and the cache-busting headers set at
      // the top of the handler still apply.
      c.header('Content-Type', TOKEN_INTROSPECTION_JWT_MEDIA_TYPE);
      return c.body(responseJwt);
    }

`
    : '';
  return `import { Hono } from 'hono';
import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
  requireIntrospectionToken,
  requireIntrospectionClient,
  requireConfidentialIntrospectionCaller,
  resolveIntrospectionToken,
  isIntrospectionTokenActive,
  buildIntrospectionResponse,
  INACTIVE_INTROSPECTION_RESPONSE,
  IntrospectionError,
  TokenError,${introspectionJwtCoreImports}
  type IntrospectionResponse,
} from '${corePkg}';${introspectionJwtImports}
import {
  tokenClientResolver as defaultTokenClientResolver,
  introspectionAccessTokenResolver as defaultAccessResolver,
  introspectionRefreshTokenResolver as defaultRefreshResolver,
} from '../resolvers.js';

export const introspectionApp = new Hono<{ Variables: Record<string, any> }>();

function isFormUrlEncoded(contentType: string): boolean {
  return contentType.toLowerCase().split(';')[0]?.trim() === 'application/x-www-form-urlencoded';
}

/**
 * Token Introspection Endpoint
 * RFC 7662 Section 2
 *
 * Confidential client only — a caller registered with
 * token_endpoint_auth_method 'none' is rejected with invalid_client
 * (RFC 7662 §2.1 / RFC 9701 §5), because a public client_id alone is not
 * authentication. Response is always cache-busting per RFC 7662 Section 2.2.
 */
introspectionApp.post('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  if (!isFormUrlEncoded(c.req.header('Content-Type') ?? '')) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      },
      400,
    );
  }

  const body = Object.fromEntries(new URLSearchParams(await c.req.text()));
  const authorization = c.req.header('Authorization') ?? '';
  const params = Object.fromEntries(
    Object.entries(body).map(([k, v]) => [k, String(v)]),
  );

  try {
    const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
    const accessTokenResolver =
      c.get('introspectionAccessTokenResolver') ?? defaultAccessResolver;
    const refreshTokenResolver =
      c.get('introspectionRefreshTokenResolver') ?? defaultRefreshResolver;

    // --- Client authentication pipeline -------------------------------------
    // OAuth 2.1 §2.3 / OIDC Core 1.0 §9, the same steps as the token endpoint.
    // RFC 7662 §2.1 requires the caller to authenticate.
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: authorization,
    });
    const introspectingClient = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      tokenClientResolver,
    );
    validateClientAuthMethod(introspectingClient, presentedCredentials);
    await verifyClientSecret(introspectingClient, presentedCredentials.clientSecret);
    // RFC 7662 §2.1 / RFC 9701 §5: the caller must be an authenticated
    // confidential client. A client registered with token_endpoint_auth_method
    // 'none' passes the pipeline above by presenting its client_id alone —
    // public information — so treating it as authenticated would let anyone
    // scan tokens. Revocation deliberately has no such step: RFC 7009 §2.1
    // lets a public client revoke its own tokens.
    requireConfidentialIntrospectionCaller(introspectingClient);
    const authenticatedClientId = presentedCredentials.clientId;

    // --- Introspection pipeline ---------------------------------------------
    // Each step below is an independent core function, called in RFC 7662 §2
    // order. Delete a call to drop that step, or insert your own logic between
    // steps.

    // RFC 7662 §2.1: token is REQUIRED (invalid_request when absent).
    const token = requireIntrospectionToken({
      token: typeof params.token === 'string' ? params.token : undefined,
    });

    // RFC 7662 §2.1: the caller must be an authenticated client (invalid_client).
    requireIntrospectionClient(authenticatedClientId);

    // RFC 7662 §2.1: token_type_hint only reorders the lookup — the other token
    // type is still searched when the hint misses.
    const resolved = await resolveIntrospectionToken({
      token,
      tokenTypeHint:
        typeof params.token_type_hint === 'string' ? params.token_type_hint : undefined,
      accessTokenResolver,
      refreshTokenResolver,
    });

    // RFC 7662 §2.2: an unknown, expired, not-yet-valid or rotated token is
    // reported as { active: false } with no other member, so the caller cannot
    // distinguish "never existed" from "no longer valid".
    let response: IntrospectionResponse = INACTIVE_INTROSPECTION_RESPONSE;
    if (resolved !== null && isIntrospectionTokenActive(resolved)) {
      response = buildIntrospectionResponse(resolved);
    }

${introspectionJwtResponseBranch}    return c.json(response);
  } catch (error) {
    if (error instanceof TokenError) {
      const status = error.statusCode as 400 | 401;
      if (error.wwwAuthenticate) c.header('WWW-Authenticate', error.wwwAuthenticate);
      return c.json(
        { error: error.error, error_description: error.errorDescription },
        status,
      );
    }
    if (error instanceof IntrospectionError) {
      const status = error.statusCode as 400 | 401;
      if (error.wwwAuthenticate) c.header('WWW-Authenticate', error.wwwAuthenticate);
      return c.json(
        { error: error.error, error_description: error.errorDescription },
        status,
      );
    }
    return c.json({ error: 'server_error' }, 500);
  }
});
`;
}

export function revocationRouteTemplate(corePkg: string): string {
  return `import { Hono } from 'hono';
import {
  extractClientCredentials,
  resolveAuthenticatedTokenClient,
  validateClientAuthMethod,
  verifyClientSecret,
  requireRevocationToken,
  requireRevocationClient,
  resolveRevocationTarget,
  validateRevocationTokenClient,
  revokeResolvedToken,
  revokeGrantAccessTokens,
  RevocationError,
  TokenError,
} from '${corePkg}';
import {
  tokenClientResolver as defaultTokenClientResolver,
  revocationResolvers as defaultRevocationResolvers,
} from '../resolvers.js';

export const revocationApp = new Hono<{ Variables: Record<string, any> }>();

function isFormUrlEncoded(contentType: string): boolean {
  return contentType.toLowerCase().split(';')[0]?.trim() === 'application/x-www-form-urlencoded';
}

/**
 * Token Revocation Endpoint
 * RFC 7009 Section 2
 *
 * Confidential clients authenticate with their registered secret method. Public
 * clients registered with token_endpoint_auth_method=none identify themselves
 * with client_id only (RFC 7009 §2.1).
 * Always returns 200 OK with no body for both "revoked" and "not found" cases
 * to prevent client side-channels (RFC 7009 Section 2.2).
 *
 * Refresh token revocation also revokes sibling access tokens via grantId
 * (RFC 7009 Section 2.1 SHOULD).
 */
revocationApp.post('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  if (!isFormUrlEncoded(c.req.header('Content-Type') ?? '')) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      },
      400,
    );
  }

  const body = Object.fromEntries(new URLSearchParams(await c.req.text()));
  const authorization = c.req.header('Authorization') ?? '';
  const params = Object.fromEntries(
    Object.entries(body).map(([k, v]) => [k, String(v)]),
  );

  try {
    const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
    const resolvers = c.get('revocationResolvers') ?? defaultRevocationResolvers;

    // --- Client authentication pipeline -------------------------------------
    // OAuth 2.1 §2.3 / OIDC Core 1.0 §9, the same steps as the token endpoint.
    // Public clients registered with token_endpoint_auth_method=none pass with
    // client_id only (RFC 7009 §2.1).
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: authorization,
    });
    const revokingClient = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      tokenClientResolver,
    );
    validateClientAuthMethod(revokingClient, presentedCredentials);
    await verifyClientSecret(revokingClient, presentedCredentials.clientSecret);
    const authenticatedClientId = presentedCredentials.clientId;

    // --- Revocation pipeline ------------------------------------------------
    // Each step below is an independent core function, called in RFC 7009 §2
    // order. Delete a call to drop that step, or insert your own logic between
    // steps.

    // RFC 7009 §2.1: token is REQUIRED (invalid_request when absent).
    const token = requireRevocationToken({
      token: typeof params.token === 'string' ? params.token : undefined,
    });

    // RFC 7009 §2.1: the caller must be an identified client (invalid_client).
    requireRevocationClient(authenticatedClientId);

    // RFC 7009 §2.1: token_type_hint only reorders the lookup — the other token
    // type is still searched when the hint misses.
    const resolved = await resolveRevocationTarget({
      token,
      tokenTypeHint:
        typeof params.token_type_hint === 'string' ? params.token_type_hint : undefined,
      resolvers,
    });

    // RFC 7009 §2.2: an unknown token is still a success, so the client cannot
    // probe which token values exist.
    if (resolved !== null) {
      // RFC 7009 §2.1: a token issued to another client is refused (invalid_grant).
      validateRevocationTokenClient(resolved, authenticatedClientId);

      await revokeResolvedToken(token, resolved, resolvers);

      // RFC 7009 §2.1 SHOULD: revoking a refresh token also revokes the access
      // tokens of the same grant. Delete this call to revoke only the presented
      // token.
      await revokeGrantAccessTokens(resolved, resolvers);
    }

    // RFC 7009 Section 2.2: empty body, 200 OK
    return c.body(null, 200);
  } catch (error) {
    if (error instanceof TokenError) {
      const status = error.statusCode as 400 | 401;
      if (error.wwwAuthenticate) c.header('WWW-Authenticate', error.wwwAuthenticate);
      return c.json(
        { error: error.error, error_description: error.errorDescription },
        status,
      );
    }
    if (error instanceof RevocationError) {
      const status = error.statusCode as 400 | 401;
      if (error.wwwAuthenticate) c.header('WWW-Authenticate', error.wwwAuthenticate);
      return c.json(
        { error: error.error, error_description: error.errorDescription },
        status,
      );
    }
    return c.json({ error: 'server_error' }, 500);
  }
});
`;
}

/**
 * The view parameter types (LoginPageParams, ConsentPageParams, ...) every
 * framework's views module declares. Shared so the Hono JSX views (views.tsx)
 * and the string views (views.ts) keep one contract. EXPERIMENTAL feature
 * types collapse to '' when their feature is off.
 */
export function viewParamTypesTemplate(
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const deviceParamTypes = features.deviceAuthorizationGrant
    ? `
export interface DeviceVerificationPageParams {
  /**
   * user_code to pre-fill the input with. Comes from the query string of
   * verification_uri_complete (RFC 8628 §3.3.1) or from the user's own previous
   * submission, so it is untrusted input and MUST be escaped before rendering.
   */
  userCode?: string;
  /**
   * Failure message for a code that did not match. RFC 8628 §5.1: the same text
   * is used for unknown, expired and already-used codes, so do not add detail
   * here — it would tell an attacker which codes exist.
   */
  error?: string;
}

export interface DeviceLoginPageParams {
  /** user_code in display form; carried through as a hidden field. */
  userCode: string;
  /** CSRF token (must be included as hidden form field) */
  csrfToken: string;
  /** Error message from a previous failed attempt */
  error?: string;
  /** Number of remaining login attempts for this device authorization */
  remainingAttempts?: number;
}

export interface DeviceApprovalPageParams {
  /**
   * user_code in display form. RFC 8628 §5.4: show it so the user can compare it
   * with the code on the device screen — that comparison is the only defense
   * against a remote phishing attempt that lured them to approve someone else's
   * device.
   */
  userCode: string;
  /** CSRF token (must be included as hidden form field) */
  csrfToken: string;
  /** Client the device authorization was requested by */
  clientId: string;
  /** Scopes the device asked for */
  scopes: string[];
}

export interface DeviceCompletedPageParams {
  /** true when the user approved, false when they denied */
  approved: boolean;
  /** Client the decision applied to */
  clientId: string;
}
`
    : '';
  const cibaParamTypes = features.ciba
    ? `
export interface CibaLoginPageParams {
  /** Login transaction id; carried through as a hidden field. */
  loginTransactionId: string;
  /** CSRF token (must be included as hidden form field) */
  csrfToken: string;
  /** Error message from a previous failed attempt */
  error?: string;
  /** Number of remaining login attempts for this login transaction */
  remainingAttempts?: number;
}

export interface CibaPendingRequestParams {
  /** auth_req_id; carried through as a hidden field of the decision form. */
  authReqId: string;
  /** Client that asked for the backchannel authentication */
  clientId: string;
  /** Scopes the client asked for */
  scopes: string[];
  /**
   * CIBA Core 1.0 §7.1 binding_message: shown so the user can compare it with
   * the message on the consumption device — the visual check that they are
   * approving THEIR transaction and not someone else's. Client-supplied text:
   * it MUST be escaped before rendering.
   */
  bindingMessage?: string;
  /** Seconds until this request expires */
  expiresInSeconds: number;
  /** Per-record CSRF token (must be included as hidden form field) */
  csrfToken: string;
}

export interface CibaPendingRequestsPageParams {
  /** Pending backchannel authentication requests addressed to the signed-in user */
  requests: CibaPendingRequestParams[];
}

export interface CibaCompletedPageParams {
  /** true when the user approved, false when they denied */
  approved: boolean;
  /** Client the decision applied to */
  clientId: string;
}
`
    : '';
  const rpInitiatedLogoutParamTypes = features.rpInitiatedLogout
    ? `
export interface LogoutConfirmationPageParams {
  /** CSRF token (must be included as hidden form field of the approve POST) */
  csrfToken: string;
}

/**
 * Parameters of the logged-out page. Deliberately empty: the completed screen
 * shows no End-User or client identifier (whoever sees the screen learns
 * nothing), and its wording never depends on whether anything was actually
 * deleted — varying it would make the page a session-existence oracle.
 */
export interface LogoutCompletedPageParams {}
`
    : '';
  const googleLoginPageParam = features.googleLogin
    ? `  /**
   * EXTENSION (google-login): GIS configuration for "Sign in with Google"
   * (redirect mode) — the g_id_onload attributes built by
   * buildGoogleSignInAttributes(): client ID, data-ux_mode="redirect", the
   * login_uri Google posts the ID token to, and the nonce bound to this
   * transaction. The view owns the markup (see defaultLoginPage). Undefined
   * when Google login is not configured; only the password form is shown then.
   */
  googleSignIn?: GoogleSignInAttributes;
`
    : '';
  return `export interface LoginPageParams {
  /**
   * CSRF token (must be included as the hidden csrf_token form field). The form
   * carries nothing else about the transaction: the browser's transaction cookie
   * says which one this is, and the token has to belong to it.
   */
  csrfToken: string;
  /** Error message from a previous failed attempt */
  error?: string;
  /** Number of remaining login attempts */
  remainingAttempts?: number;
  /**
   * OIDC Core 1.0 §3.1.2.1 login_hint: untrusted external value the OP MAY use to
   * pre-fill the login form. Treated as a hint only (initial display); it MUST be
   * HTML-attribute escaped before rendering since it is unauthenticated input.
   */
  loginHint?: string;
${googleLoginPageParam}}

export interface ConsentPageParams {
  /**
   * CSRF token (must be included as the hidden csrf_token form field). The form
   * carries nothing else about the transaction: the browser's transaction cookie
   * says which one this is, and the token has to belong to it.
   */
  csrfToken: string;
  /** Scopes requested by the client */
  scopes: string[];
  /** Client ID requesting authorization */
  clientId: string;
}

export interface ErrorPageParams {
  /** Error message to display (OAuth error code for authorization errors) */
  error: string;
  /** Optional human-readable detail (OAuth error_description) */
  errorDescription?: string;
  /** HTTP status code */
  statusCode: number;
}
${deviceParamTypes}${cibaParamTypes}${rpInitiatedLogoutParamTypes}
`;
}

/**
 * The Views interface every framework's views module declares (see
 * viewParamTypesTemplate). Each member returns the module's own ViewResult.
 */
export function viewsInterfaceTemplate(
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  const deviceViewsMembers = features.deviceAuthorizationGrant
    ? `  /** EXPERIMENTAL (RFC 8628 §3.3): render the user_code entry form */
  deviceVerificationPage(params: DeviceVerificationPageParams): ViewResult;
  /** EXPERIMENTAL (RFC 8628 §3.3): render the sign-in form for a device flow */
  deviceLoginPage(params: DeviceLoginPageParams): ViewResult;
  /** EXPERIMENTAL (RFC 8628 §3.3): render the approve / deny screen */
  deviceApprovalPage(params: DeviceApprovalPageParams): ViewResult;
  /** EXPERIMENTAL (RFC 8628 §3.3): render the "go back to your device" screen */
  deviceCompletedPage(params: DeviceCompletedPageParams): ViewResult;
`
    : '';
  const cibaViewsMembers = features.ciba
    ? `  /** EXPERIMENTAL (CIBA Core 1.0): render the sign-in form of the authentication device UI */
  cibaLoginPage(params: CibaLoginPageParams): ViewResult;
  /** EXPERIMENTAL (CIBA Core 1.0): render the pending-requests approval screen */
  cibaPendingRequestsPage(params: CibaPendingRequestsPageParams): ViewResult;
  /** EXPERIMENTAL (CIBA Core 1.0): render the decision-recorded screen */
  cibaCompletedPage(params: CibaCompletedPageParams): ViewResult;
`
    : '';
  const rpInitiatedLogoutViewsMembers = features.rpInitiatedLogout
    ? `  /** EXPERIMENTAL (RP-Initiated Logout 1.0 §2): render the logout confirmation screen */
  logoutConfirmationPage(params: LogoutConfirmationPageParams): ViewResult;
  /** EXPERIMENTAL (RP-Initiated Logout 1.0): render the logged-out screen */
  logoutCompletedPage(params: LogoutCompletedPageParams): ViewResult;
`
    : '';
  return `export interface Views {
  /** Render the login page (and login error page when error is set) */
  loginPage(params: LoginPageParams): ViewResult;
  /** Render the consent/authorization page */
  consentPage(params: ConsentPageParams): ViewResult;
  /** Render a generic error page */
  errorPage(params: ErrorPageParams): ViewResult;
${deviceViewsMembers}${cibaViewsMembers}${rpInitiatedLogoutViewsMembers}}
`;
}

export function viewsTemplate(
  features: OidcFeatureConfig = DEFAULT_FEATURES,
): string {
  // EXPERIMENTAL (RFC 8628 §3.3): the four device pages are generated only with
  // --enable device-authorization-grant. Every interpolation below collapses to
  // '' when the feature is off, so the default views.ts is unchanged byte for byte.
  const deviceDefaultViews = features.deviceAuthorizationGrant
    ? `function defaultDeviceVerificationPage(params: DeviceVerificationPageParams): string {
  const errorHtml = params.error
    ? \`<p style="color: red;">\${escapeHtml(params.error)}</p>\`
    : '';

  return \`<!DOCTYPE html>
<html>
<head><title>Device Activation</title></head>
<body>
  <h1>Device Activation</h1>
  <p>Enter the code shown on your device.</p>
  \${errorHtml}
  <form method="POST" action="/device">
    <div>
      <label for="user_code">Code:</label>
      <input type="text" id="user_code" name="user_code" value="\${escapeHtml(params.userCode ?? '')}" required />
    </div>
    <button type="submit">Continue</button>
  </form>
</body>
</html>\`;
}

function defaultDeviceLoginPage(params: DeviceLoginPageParams): string {
  const errorHtml = params.error
    ? \`<p style="color: red;">\${escapeHtml(params.error)}\${
        params.remainingAttempts !== undefined
          ? \`. Attempts remaining: \${params.remainingAttempts}\`
          : ''
      }</p>\`
    : '';

  return \`<!DOCTYPE html>
<html>
<head><title>Login</title></head>
<body>
  <h1>Login</h1>
  <p>Activating device code <strong>\${escapeHtml(params.userCode)}</strong></p>
  \${errorHtml}
  <form method="POST" action="/device/login">
    <input type="hidden" name="user_code" value="\${escapeHtml(params.userCode)}" />
    <input type="hidden" name="csrf_token" value="\${escapeHtml(params.csrfToken)}" />
    <div>
      <label for="username">Username:</label>
      <input type="text" id="username" name="username" required />
    </div>
    <div>
      <label for="password">Password:</label>
      <input type="password" id="password" name="password" required />
    </div>
    <button type="submit">Login</button>
  </form>
</body>
</html>\`;
}

function defaultDeviceApprovalPage(params: DeviceApprovalPageParams): string {
  const scopeListHtml = params.scopes
    .map((s) => \`    <li>\${escapeHtml(s)}</li>\`)
    .join('\\n');

  // RFC 8628 §5.4: the code is repeated here on purpose. Ask the user to check it
  // against the device in front of them before approving.
  return \`<!DOCTYPE html>
<html>
<head><title>Authorize Device</title></head>
<body>
  <h1>Authorize Device</h1>
  <p>Confirm that your device is showing this code: <strong>\${escapeHtml(params.userCode)}</strong></p>
  <p>Do not continue if the code does not match.</p>
  <p>Client <strong>\${escapeHtml(params.clientId)}</strong> is requesting access to the following scopes:</p>
  <ul>
\${scopeListHtml}
  </ul>
  <form method="POST" action="/device/approve">
    <input type="hidden" name="user_code" value="\${escapeHtml(params.userCode)}" />
    <input type="hidden" name="csrf_token" value="\${escapeHtml(params.csrfToken)}" />
    <button type="submit" name="decision" value="approve">Approve</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </form>
</body>
</html>\`;
}

function defaultDeviceCompletedPage(params: DeviceCompletedPageParams): string {
  const outcome = params.approved
    ? \`<p>You approved <strong>\${escapeHtml(params.clientId)}</strong>.</p>\`
    : \`<p>You denied <strong>\${escapeHtml(params.clientId)}</strong>.</p>\`;

  return \`<!DOCTYPE html>
<html>
<head><title>Device Activation</title></head>
<body>
  <h1>Device Activation</h1>
\${outcome}
  <p>You can close this page and go back to your device.</p>
</body>
</html>\`;
}

`
    : '';
  const deviceDefaultViewsEntries = features.deviceAuthorizationGrant
    ? `  deviceVerificationPage: defaultDeviceVerificationPage,
  deviceLoginPage: defaultDeviceLoginPage,
  deviceApprovalPage: defaultDeviceApprovalPage,
  deviceCompletedPage: defaultDeviceCompletedPage,
`
    : '';
  // EXPERIMENTAL (CIBA Core 1.0): the three CIBA pages are generated only with
  // --enable ciba. Every interpolation below collapses to '' when the feature
  // is off, so the default views.ts is unchanged byte for byte.
  const cibaDefaultViews = features.ciba
    ? `function defaultCibaLoginPage(params: CibaLoginPageParams): string {
  const errorHtml = params.error
    ? \`<p style="color: red;">\${escapeHtml(params.error)}\${
        params.remainingAttempts !== undefined
          ? \`. Attempts remaining: \${params.remainingAttempts}\`
          : ''
      }</p>\`
    : '';

  return \`<!DOCTYPE html>
<html>
<head><title>Sign in</title></head>
<body>
  <h1>Sign in</h1>
  <p>Sign in to review sign-in requests sent to you.</p>
  \${errorHtml}
  <form method="POST" action="/ciba/login">
    <input type="hidden" name="login_transaction_id" value="\${escapeHtml(params.loginTransactionId)}" />
    <input type="hidden" name="csrf_token" value="\${escapeHtml(params.csrfToken)}" />
    <div>
      <label for="username">Username:</label>
      <input type="text" id="username" name="username" required />
    </div>
    <div>
      <label for="password">Password:</label>
      <input type="password" id="password" name="password" required />
    </div>
    <button type="submit">Login</button>
  </form>
</body>
</html>\`;
}

function defaultCibaPendingRequestsPage(params: CibaPendingRequestsPageParams): string {
  if (params.requests.length === 0) {
    return \`<!DOCTYPE html>
<html>
<head><title>Sign-in Requests</title></head>
<body>
  <h1>Sign-in Requests</h1>
  <p>No pending sign-in requests.</p>
</body>
</html>\`;
  }

  // CIBA Core 1.0 §7.1: the binding_message is repeated here on purpose. Ask
  // the user to check it against the device that started the request before
  // approving. The Deny button is rendered with the same prominence as Approve.
  const requestListHtml = params.requests
    .map((request) => {
      const scopeListHtml = request.scopes
        .map((s) => \`      <li>\${escapeHtml(s)}</li>\`)
        .join('\\n');
      const bindingMessageHtml = request.bindingMessage
        ? \`    <p>Confirm that your device is showing this message: <strong>\${escapeHtml(request.bindingMessage)}</strong></p>\\n\`
        : '';
      return \`  <section>
    <p>Client <strong>\${escapeHtml(request.clientId)}</strong> is requesting access to the following scopes:</p>
    <ul>
\${scopeListHtml}
    </ul>
\${bindingMessageHtml}    <p>This request expires in \${request.expiresInSeconds} seconds.</p>
    <form method="POST" action="/ciba/approve">
      <input type="hidden" name="auth_req_id" value="\${escapeHtml(request.authReqId)}" />
      <input type="hidden" name="csrf_token" value="\${escapeHtml(request.csrfToken)}" />
      <button type="submit" name="decision" value="approve">Approve</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </form>
  </section>\`;
    })
    .join('\\n');

  return \`<!DOCTYPE html>
<html>
<head><title>Sign-in Requests</title></head>
<body>
  <h1>Sign-in Requests</h1>
  <p>Only approve a request you started yourself on another device.</p>
\${requestListHtml}
</body>
</html>\`;
}

function defaultCibaCompletedPage(params: CibaCompletedPageParams): string {
  const outcome = params.approved
    ? \`<p>You approved <strong>\${escapeHtml(params.clientId)}</strong>.</p>\`
    : \`<p>You denied <strong>\${escapeHtml(params.clientId)}</strong>.</p>\`;

  return \`<!DOCTYPE html>
<html>
<head><title>Sign-in Requests</title></head>
<body>
  <h1>Sign-in Requests</h1>
\${outcome}
  <p>You can close this page and go back to your device.</p>
</body>
</html>\`;
}

`
    : '';
  const cibaDefaultViewsEntries = features.ciba
    ? `  cibaLoginPage: defaultCibaLoginPage,
  cibaPendingRequestsPage: defaultCibaPendingRequestsPage,
  cibaCompletedPage: defaultCibaCompletedPage,
`
    : '';
  // EXPERIMENTAL (RP-Initiated Logout 1.0): the two logout pages are generated
  // only with --enable rp-initiated-logout. Every interpolation below collapses
  // to '' when the feature is off, so the default views.ts is unchanged byte
  // for byte.
  const rpInitiatedLogoutDefaultViews = features.rpInitiatedLogout
    ? `// RP-Initiated Logout 1.0 §2: the wording is fixed for every path into this
// screen (no hint, an invalid or expired hint, another user's session, no
// session at all), so the page cannot be used as an oracle for session state
// or for why the hint failed.
function defaultLogoutConfirmationPage(params: LogoutConfirmationPageParams): string {
  return \`<!DOCTYPE html>
<html>
<head><title>Log out</title></head>
<body>
  <h1>Log out</h1>
  <p>Do you want to log out of the OpenID Provider?</p>
  <p>If you did not request this, close this page.</p>
  <form method="POST" action="/logout/approve">
    <input type="hidden" name="csrf_token" value="\${escapeHtml(params.csrfToken)}" />
    <button type="submit">Log out</button>
  </form>
</body>
</html>\`;
}

function defaultLogoutCompletedPage(_params: LogoutCompletedPageParams): string {
  return \`<!DOCTYPE html>
<html>
<head><title>Logged out</title></head>
<body>
  <h1>Logged out</h1>
  <p>You have been logged out.</p>
  <p>You can close this page.</p>
</body>
</html>\`;
}

`
    : '';
  const rpInitiatedLogoutDefaultViewsEntries = features.rpInitiatedLogout
    ? `  logoutConfirmationPage: defaultLogoutConfirmationPage,
  logoutCompletedPage: defaultLogoutCompletedPage,
`
    : '';
  // EXTENSION (google-login): the login page gains a pre-rendered "Sign in with
  // Google" button. Every interpolation collapses to '' when the feature is off,
  // so the default views.ts is unchanged byte for byte.
  const googleViewsImport = features.googleLogin
    ? `// EXTENSION (google-login): the GIS configuration type and the helper that
// serializes it into this string template. The package generates no UI; the
// three elements GIS needs are written out in defaultLoginPage below.
import {
  googleSignInAttributesToHtml,
  GOOGLE_GSI_CLIENT_SCRIPT_URL,
  type GoogleSignInAttributes,
} from '${GOOGLE_LOGIN_PACKAGE}/sign-in';

`
    : '';
  const googleSignInSnippet = features.googleLogin
    ? `
  // EXTENSION (google-login): the three elements GIS needs for redirect mode —
  // its client script, #g_id_onload carrying the configuration (attribute
  // values escaped by googleSignInAttributesToHtml), and .g_id_signin, which
  // GIS replaces with the button. Style the button through the GIS button
  // attributes (data-theme, data-size, data-text, ...) on .g_id_signin.
  const googleSignInHtml = params.googleSignIn
    ? \`  <hr />\\n  <section aria-label="Sign in with Google">\\n    <script src="\${GOOGLE_GSI_CLIENT_SCRIPT_URL}" async></script>\\n    <div \${googleSignInAttributesToHtml(params.googleSignIn)}></div>\\n    <div class="g_id_signin" data-type="standard"></div>\\n  </section>\\n\`
    : '';
`
    : '';
  const googleSignInPlaceholder = features.googleLogin ? '${googleSignInHtml}' : '';
  return `/**
 * UI Views for OpenID Connect Provider.
 *
 * This file contains the default HTML of every user-facing screen. The screen
 * routes in pages/ deliver these views (pages/login.ts renders loginPage, and so
 * on); the logic in routes/ never renders anything — it returns outcomes the
 * pages turn into HTTP. Customize these functions to match your application's
 * design, or change how a screen is delivered in its pages/ module.
 *
 * Each function receives typed parameters and returns a ViewResult: either an
 * HTML string (wrapped into a text/html Response by renderView) or a
 * framework-native Response when you need full control over status / headers /
 * body. You can replace the default HTML with any templating engine, JSX
 * rendering, or UI framework of your choice.
 */

${googleViewsImport}// ============================================================
// View Parameter Types
// ============================================================

${viewParamTypesTemplate(features)}// ============================================================
// Views Interface
// ============================================================

/**
 * A view may return a plain HTML string (the common case) or a fully formed
 * Response when it needs to control the status code, headers, or stream a
 * framework-native body. renderView() normalizes both into a Response.
 */
export type ViewResult = string | Response;

${viewsInterfaceTemplate(features)}
/** Options applied when renderView wraps an HTML string into a Response. */
export interface RenderViewInit {
  /** HTTP status code for the generated Response (defaults to 200). */
  status?: number;
}

/**
 * Normalize a ViewResult into a Response.
 *
 * - A Response is returned untouched, so a custom view keeps full control over
 *   its status, headers, and body (e.g. returning a framework-rendered Response).
 * - A string is wrapped into an HTML Response with the given status.
 *
 * Routes call renderView() instead of hard-coding string handling, so the Views
 * return type can stay ViewResult and never silently collapse back to string.
 */
export function renderView(result: ViewResult, init?: RenderViewInit): Response {
  if (typeof result === 'string') {
    return new Response(result, {
      status: init?.status ?? 200,
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    });
  }
  if (result instanceof Response) {
    return result;
  }
  return result;
}

// ============================================================
// Default Views Implementation
// Replace the functions below to customize the UI.
// ============================================================

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function defaultLoginPage(params: LoginPageParams): string {
  // Every string interpolated into HTML is escaped, including values that are
  // server-generated by the default stores: users may replace stores/views.
  const errorHtml = params.error
    ? \`<p style="color: red;">\${escapeHtml(params.error)}\${
        params.remainingAttempts !== undefined
          ? \`. Attempts remaining: \${params.remainingAttempts}\`
          : ''
      }</p>\`
    : '';
${googleSignInSnippet}
  return \`<!DOCTYPE html>
<html>
<head><title>Login</title></head>
<body>
  <h1>Login</h1>
  \${errorHtml}
  <form method="POST" action="/login">
    <input type="hidden" name="csrf_token" value="\${escapeHtml(params.csrfToken)}" />
    <div>
      <label for="username">Username:</label>
      <input type="text" id="username" name="username" value="\${escapeHtml(params.loginHint ?? '')}" required />
    </div>
    <div>
      <label for="password">Password:</label>
      <input type="password" id="password" name="password" required />
    </div>
    <button type="submit">Login</button>
  </form>
${googleSignInPlaceholder}</body>
</html>\`;
}

// The submit buttons below carry the authorization decision (OIDC Core 1.0
// Section 3.1.2.4). The consent handler accepts exactly two values — 'approve'
// and 'deny' — and rejects everything else with 400, so customizing this markup
// must keep both button values as they are: renaming 'approve' makes every
// approval fail, and renaming 'deny' makes the Deny button rejected as well.
// See routes/consent.ts (Next.js: consent/page.tsx and consent/actions.ts).
function defaultConsentPage(params: ConsentPageParams): string {
  // Every string interpolated into HTML is escaped, including values that are
  // server-generated by the default stores: users may replace stores/views.
  const scopeListHtml = params.scopes
    .map((s) => \`    <li>\${escapeHtml(s)}</li>\`)
    .join('\\n');

  const escapedClientId = escapeHtml(params.clientId);

  return \`<!DOCTYPE html>
<html>
<head><title>Consent</title></head>
<body>
  <h1>Authorize Application</h1>
  <p>Client <strong>\${escapedClientId}</strong> is requesting access to the following scopes:</p>
  <ul>
\${scopeListHtml}
  </ul>
  <form method="POST" action="/consent">
    <input type="hidden" name="csrf_token" value="\${escapeHtml(params.csrfToken)}" />
    <button type="submit" name="action" value="approve">Approve</button>
    <button type="submit" name="action" value="deny">Deny</button>
  </form>
</body>
</html>\`;
}

function defaultErrorPage(params: ErrorPageParams): string {
  // Escape error and error_description so a crafted error_description cannot
  // inject markup into the browser error page (XSS).
  const descriptionHtml = params.errorDescription
    ? \`  <p>\${escapeHtml(params.errorDescription)}</p>\\n\`
    : '';

  return \`<!DOCTYPE html>
<html>
<head><title>Error</title></head>
<body>
  <h1>Error</h1>
  <p>\${escapeHtml(params.error)}</p>
\${descriptionHtml}</body>
</html>\`;
}

${deviceDefaultViews}${cibaDefaultViews}${rpInitiatedLogoutDefaultViews}/**
 * Default Views used when no custom views are injected.
 * These render minimal, unstyled HTML so the flow works out of the box.
 */
export const defaultViews: Views = {
  loginPage: defaultLoginPage,
  consentPage: defaultConsentPage,
  errorPage: defaultErrorPage,
${deviceDefaultViewsEntries}${cibaDefaultViewsEntries}${rpInitiatedLogoutDefaultViewsEntries}};

/**
 * Build a Views instance, overriding any subset of the default views with your
 * own implementation. Inject the result through the provider options instead of
 * editing this file:
 *
 * @example
 * // Provide your own login UI while keeping the default consent/error pages.
 * createApp({
 *   signingKeyProvider,
 *   views: {
 *     loginPage: (params) => myCustomLoginTemplate(params),
 *   },
 * });
 */
export function createViews(overrides?: Partial<Views>): Views {
  if (!overrides) return defaultViews;
  return { ...defaultViews, ...overrides };
}
`;
}
