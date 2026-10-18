/**
 * Hono framework templates for OpenID Connect Provider
 */

import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';
import type { DbKind } from '../../db.js';
import { databaseNames } from '../db/names.js';

import { EXPERIMENTAL_PACKAGE, GOOGLE_LOGIN_PACKAGE } from '../packages.js';
export { EXPERIMENTAL_PACKAGE, GOOGLE_LOGIN_PACKAGE };
export { tokenRouteTemplate } from './routes/token.js';
export { authorizeRouteTemplate } from './routes/authorize.js';
export { userinfoRouteTemplate } from './routes/userinfo.js';
export { introspectionRouteTemplate } from './routes/introspection.js';
export { revocationRouteTemplate } from './routes/revocation.js';
export { discoveryRouteTemplate, jwksRouteTemplate } from './routes/metadata.js';
export {
  parRouteTemplate,
  registerRouteTemplate,
  deviceAuthorizationRouteTemplate,
  backchannelAuthenticationRouteTemplate,
} from './routes/experimental-api.js';
export { loginRouteTemplate } from './routes/login.js';
export { consentRouteTemplate } from './routes/consent.js';

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
  // EXPERIMENTAL (RFC 7591 §3.1): the client registration endpoint is POST-only.
  const dcrMethod = features.dynamicClientRegistration
    ? `  '/register': ['POST'],\n`
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
${introspectionMethod}${revocationMethod}${parMethod}${deviceMethods}${cibaMethods}${logoutMethods}${dcrMethod}  '/.well-known/jwks.json': ['GET'],
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
function honoStorageTemplateParts(db: DbKind | undefined): {
  defaultStoresImport: string;
  inMemoryClientResolverImport: string;
  dbImports: string;
  storageDoc: string;
  clientResolverDoc: string;
  defaultStores: string;
  defaultClientResolver: string;
  clientKeyResolverDoc: string;
  defaultClientKeyResolver: string;
} {
  if (!db) {
    return {
      defaultStoresImport: '  defaultProviderStores,\n',
      inMemoryClientResolverImport: '  createInMemoryClientKeyResolver,\n  createInMemoryClientResolver,\n',
      dbImports: '',
      storageDoc: 'Persistent stores, or a request-aware factory for bindings such as Cloudflare D1.',
      clientResolverDoc: '',
      defaultStores: 'defaultProviderStores',
      defaultClientResolver: 'createInMemoryClientResolver()',
      clientKeyResolverDoc: CLIENT_KEY_RESOLVER_DOC + `   * Defaults to the keys of the clients of config.ts (ClientRegistration.keys).
   */\n`,
      defaultClientKeyResolver: 'createInMemoryClientKeyResolver()',
    };
  }
  const names = databaseNames(db);
  return {
    defaultStoresImport: '',
    inMemoryClientResolverImport: '',
    dbImports: `import { createDatabase } from './db/instance.js';
import { ${names.createProviderStores} } from './db/stores.js';
import { ${names.createClientKeyResolver}, ${names.createClientResolver} } from './db/clients.js';\n`,
    storageDoc: `Stores to use instead of db/: ${names.storesDescription} on the database db/instance.ts creates for each request.`,
    clientResolverDoc: `  /** Clients to use instead of ${names.clientsDescription} (registerClient() in db/clients.ts). */\n`,
    defaultStores: `${names.createProviderStores}(createDatabase(context))`,
    defaultClientResolver: `${names.createClientResolver}(createDatabase(c))`,
    clientKeyResolverDoc: CLIENT_KEY_RESOLVER_DOC + `   * Defaults to ${names.clientKeysDescription}, read for each request.
   */\n`,
    defaultClientKeyResolver: `${names.createClientKeyResolver}(createDatabase(c))`,
  };
}

/** The start of the doc comment of the clientKeyResolver option. */
const CLIENT_KEY_RESOLVER_DOC = `  /**
   * The public keys each client registered, one purpose at a time
   * (ClientKeyResolver in core). The OP verifies signed Request Objects with
   * the keys of request_object.
`;

export function appTemplate(
  _corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  db?: DbKind,
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
  // EXPERIMENTAL (RFC 7591): the client registration endpoint is a back-channel
  // POST endpoint (optionally Bearer-guarded), so it gets the same CORS policy
  // as /token. The issued clients are resolved by wrapping the configured
  // client resolver with the dynamic registration store (store.ts).
  const dcrImport = features.dynamicClientRegistration
    ? `import { registerApp, dynamicClientRegistrationConfig } from './routes/register.js';\n`
    : '';
  const dcrCors = features.dynamicClientRegistration
    ? `  app.use('/register', protectedCors);\n`
    : '';
  const dcrMount = features.dynamicClientRegistration
    ? `  app.route('/register', registerApp);\n`
    : '';
  const dcrStorageContext = features.dynamicClientRegistration
    ? `    c.set('dynamicClientStore', dynamicClientStore);
    c.set('dynamicClientRegistrationConfig', { ...dynamicClientRegistrationConfig, ...options.dynamicClientRegistration });\n`
    : '';
  const dcrStoreImport = features.dynamicClientRegistration
    ? `  dynamicClientStore,
  withDynamicallyRegisteredClients,\n`
    : '';
  const dcrOptionsField = features.dynamicClientRegistration
    ? `  /**
   * EXPERIMENTAL (RFC 7591): override the generated dynamic client registration
   * settings (routes/register.ts) per deployment — for example from environment
   * variables — without editing the generated file. Unset fields keep the
   * generated defaults.
   */
  dynamicClientRegistration?: {
    initialAccessToken?: string;
    maxRegisteredClients?: number;
    maxRegistrationBodyBytes?: number;
  };
`
    : '';
  // EXPERIMENTAL (RFC 7591): the token endpoint resolves clients through its
  // own resolver, so both resolvers get the dynamic registration fallback.
  const clientResolverAssignment = features.dynamicClientRegistration
    ? `    // EXPERIMENTAL (RFC 7591): dynamically registered clients resolve after the
    // configured clients, so a static registration always wins.
    const clientResolver = withDynamicallyRegisteredClients(
      options.clientResolver ?? ${storageParts.defaultClientResolver},
    );`
    : `    const clientResolver =
      options.clientResolver ?? ${storageParts.defaultClientResolver};`;
  const tokenClientResolverContext = features.dynamicClientRegistration
    ? `    c.set('tokenClientResolver', options.tokenClientResolver
      ? withDynamicallyRegisteredClients(options.tokenClientResolver)
      : clientResolver);`
    : `    c.set('tokenClientResolver', options.tokenClientResolver ?? clientResolver);`;
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
${introspectionImport}${revocationImport}${parImport}${deviceImport}${cibaImport}${logoutImport}${dcrImport}import { jwksApp } from './routes/jwks.js';
import { discoveryApp } from './routes/discovery.js';
import { loginPage } from './pages/login.js';
import { consentPage } from './pages/consent.js';
import {
${storageParts.inMemoryClientResolverImport}  createProviderConfig,
  type ProviderConfig,
} from './config.js';
import {
  createStoreResolvers,
} from './resolvers.js';
import {
${storageParts.defaultStoresImport}${parStoreImport}${deviceStoreImport}${cibaStoreImport}${dcrStoreImport}  type ProviderStores,
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
  ClientKeyResolver,
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
${storageParts.clientResolverDoc}  clientResolver?: ClientResolver;
  tokenClientResolver?: TokenClientResolver;
${storageParts.clientKeyResolverDoc}  clientKeyResolver?: ClientKeyResolver;
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
   * acr / amr of the tokens (OIDC Core 1.0 §2 / §3.1.2.1 / RFC 9068 §2.2.1):
   * return the acr / amr your login satisfied for the acr values the client
   * requested. The ID Token carries both and the access token the acr.
   * Omit it to put the most preferred requested acr value (acr_values) into
   * both tokens, without amr (resolveTokenAcrAmr() in routes/token.ts).
   */
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
${cibaOptionsField}${dcrOptionsField}${googleLoginOptionsFields}  corsOrigins?: CorsOrigins;
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
${introspectionCors}${revocationCors}${parCors}${deviceCors}${cibaCors}${dcrCors}  app.use('/.well-known/openid-configuration', publicCors);
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
${clientResolverAssignment}
    const stores = await resolveProviderStores(options.storage, c);
    const storeResolvers = createStoreResolvers(stores);

    c.set('signingKeys', signingKeys);
    c.set('idTokenSigningKeys', idTokenSigningKeys);
    c.set('userinfoSigningKeys', userinfoSigningKeys);
    c.set('config', createProviderConfig(options.config));
    c.set('clientResolver', clientResolver);
${tokenClientResolverContext}
    c.set('clientKeyResolver', options.clientKeyResolver ?? ${storageParts.defaultClientKeyResolver});
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
${refreshStorageContext}${introspectionStorageContext}${revocationStorageContext}${parStorageContext}${deviceStorageContext}${cibaStorageContext}${dcrStorageContext}${googleLoginStorageContext}
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
${introspectionMount}${revocationMount}${parMount}${deviceMount}${cibaMount}${logoutMount}${dcrMount}  app.route('/.well-known/jwks.json', jwksApp);
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
  return `import {
  createClientKeyResolver,
  type ClientInfo,
  type ClientKeyResolver,
  type ClientKeysByPurpose,
  type ClientResolver,
  type TokenClientInfo,
  type TokenClientResolver,
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
 * scope (RFC 7591 §2 \`scope\`, from ClientInfo / TokenClientInfo): the scope
 * values this client may request. When set, a request for any other scope is
 * rejected with invalid_scope at /authorize (and at the device and CIBA
 * endpoints when they are generated). Leave it out to let the client request
 * every scope the provider accepts.
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
 *
 * The client's public keys are not part of it: each process that needs them
 * asks the ClientKeyResolver for the keys of its own purpose
 * (ClientRegistration.keys below, or the client_jwks of db/ with --db).
 */
export type RegisteredClient = ClientInfo & TokenClientInfo & {
  userinfoSignedResponseAlg?: 'RS256' | 'ES256';
  idTokenSignedResponseAlg?: 'RS256' | 'ES256';${cibaClientField}
};

/**
 * A client as this file lists it: the RegisteredClient and its public keys by
 * purpose (keys). A purpose names the process that uses the keys, such as
 * request_object for the signed Request Objects the OP verifies (OIDC Core 1.0
 * §6.3.2), or private_key_jwt and dpop for processes a project adds. Register
 * the same key under two purposes to use it for both.
 */
export type ClientRegistration = RegisteredClient & {
  keys?: ClientKeysByPurpose;
};

/**
 * Optional in-memory defaults for quick local testing only.
 * Prefer D1, KV, or another project-owned client resolver in real projects.
 */
export const defaultRegisteredClients: ReadonlyMap<string, ClientRegistration> = new Map([
  [
    'example-client',
    {
      clientId: 'example-client',
      clientSecret: 'example-secret',
      redirectUris: ['http://localhost:3000/callback'],
      clientType: 'confidential' as const,
${exampleClientGrantFields}      // RFC 7591 §2: token_endpoint_auth_method default is client_secret_basic.
      // The sample client authenticates with client_secret_post, so register it explicitly.
      tokenEndpointAuthMethods: ['client_secret_post'],
      // OIDC Dynamic Client Registration 1.0 §2: default_max_age (seconds).
      // When the authorization request omits max_age, the OP applies this as the
      // default re-authentication freshness. A request-supplied max_age overrides it.
      defaultMaxAge: 3600,
    },
  ],
]);

export function createInMemoryClientResolver(
  clients: ReadonlyMap<string, ClientRegistration> = defaultRegisteredClients,
): ClientResolver & TokenClientResolver {
  return {
    async findClient(clientId: string): Promise<RegisteredClient | null> {
      const registration = clients.get(clientId);
      if (!registration) return null;
      const { keys: _keys, ...client } = registration;
      return client;
    },
  };
}

/**
 * The public keys of the clients (ClientRegistration.keys), one purpose at a
 * time: the ClientKeyResolver of an OP generated without --db. The map is read
 * as it is when a key is asked for.
 */
export function createInMemoryClientKeyResolver(
  clients: ReadonlyMap<string, ClientRegistration> = defaultRegisteredClients,
): ClientKeyResolver {
  return createClientKeyResolver((clientId) => clients.get(clientId)?.keys);
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
  // EXPERIMENTAL (RFC 7591): the record of a dynamic registration is the same
  // RegisteredClient shape the static clients use, so the issued client rides
  // the existing resolution and validation paths unchanged.
  const dcrStoreTypeImport = features.dynamicClientRegistration
    ? `
import type { RegisteredClient } from './config.js';`
    : '';
  const dcrStoreImplementation = features.dynamicClientRegistration
    ? `
/**
 * EXPERIMENTAL — store contract for dynamically registered clients (RFC 7591).
 *
 * - get(clientId): return the registered client, or undefined when unknown.
 * - save(client): persist the registration under client.clientId.
 * - count(): how many dynamic registrations exist, for the
 *   maxRegisteredClients inventory cap (RFC 7591 §5 DoS consideration).
 */
export interface DynamicallyRegisteredClientStore {
  get(clientId: string): Promise<RegisteredClient | undefined>;
  save(client: RegisteredClient): Promise<void>;
  count(): Promise<number>;
}

/**
 * EXPERIMENTAL — in-memory store for dynamically registered clients (RFC 7591).
 *
 * Dynamic registrations live only in this process: they survive neither a
 * restart nor a second instance (the statically registered clients do), so a
 * long-running deployment needs a persistent implementation of the contract
 * above. There is no expiry: RFC 7592 (deregistration) is not implemented, so
 * the inventory cap and a restart are the only ways a registration goes away.
 */
export class InMemoryDynamicallyRegisteredClientStore
  implements DynamicallyRegisteredClientStore
{
  private clients = new Map<string, RegisteredClient>();

  async get(clientId: string): Promise<RegisteredClient | undefined> {
    return this.clients.get(clientId);
  }

  async save(client: RegisteredClient): Promise<void> {
    this.clients.set(client.clientId, client);
  }

  async count(): Promise<number> {
    return this.clients.size;
  }
}

// Kept on globalThis for the same reason as the provider stores above: Next.js
// instantiates route handlers and server actions in separate module layers.
const dynamicClientStoreRegistry = globalThis as typeof globalThis & {
  __oidcDynamicallyRegisteredClientStore?: DynamicallyRegisteredClientStore;
};

export const dynamicClientStore: DynamicallyRegisteredClientStore =
  (dynamicClientStoreRegistry.__oidcDynamicallyRegisteredClientStore ??=
    new InMemoryDynamicallyRegisteredClientStore());

/**
 * EXPERIMENTAL — consult the dynamically registered clients (RFC 7591) after
 * the configured resolver, so a statically registered client can never be
 * shadowed by a dynamic registration (ids minted at /register carry the dcr-
 * prefix and cannot collide with human-named static ids anyway).
 *
 * The wrapper keeps the base resolver's own type: a value serving as both
 * ClientResolver and TokenClientResolver stays usable as both, and the
 * RegisteredClient records the store adds satisfy either view.
 */
export function withDynamicallyRegisteredClients<
  Resolver extends { findClient(clientId: string): Promise<any> },
>(base: Resolver): Resolver {
  return {
    ...base,
    async findClient(clientId: string): Promise<RegisteredClient | null> {
      const registered = (await base.findClient(clientId)) as RegisteredClient | null;
      if (registered) {
        return registered;
      }
      return (await dynamicClientStore.get(clientId)) ?? null;
    },
  } as Resolver;
}
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
} from '${corePkg}';${parStoreTypeImport}${deviceStoreTypeImport}${cibaStoreTypeImport}${dcrStoreTypeImport}${googleLoginStoreTypeImport}

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
${parStoreImplementation}${deviceStoreImplementation}${cibaStoreImplementation}${dcrStoreImplementation}`;
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
  ClientKeyResolver,
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
import { createInMemoryClientKeyResolver, createInMemoryClientResolver } from './config.js';
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
 * Default key resolver: the keys of the clients of config.ts
 * (ClientRegistration.keys), one purpose at a time.
 */
export const clientKeyResolver: ClientKeyResolver = createInMemoryClientKeyResolver();

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

export function applyTemplate(
  _corePkg: string,
  features: OidcFeatureConfig = DEFAULT_FEATURES,
  db?: DbKind,
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
  // EXPERIMENTAL (RFC 7591): the client registration endpoint is a back-channel
  // POST endpoint (optionally Bearer-guarded), so it gets the same CORS policy
  // as /token. The issued clients are resolved by wrapping the configured
  // client resolver with the dynamic registration store (store.ts).
  const dcrImport = features.dynamicClientRegistration
    ? `import { registerApp, dynamicClientRegistrationConfig } from './routes/register.js';\n`
    : '';
  const dcrCors = features.dynamicClientRegistration
    ? `  app.use('/register', protectedCors);\n`
    : '';
  const dcrMount = features.dynamicClientRegistration
    ? `  app.route('/register', registerApp);\n`
    : '';
  const dcrStorageContext = features.dynamicClientRegistration
    ? `    c.set('dynamicClientStore', dynamicClientStore);
    c.set('dynamicClientRegistrationConfig', { ...dynamicClientRegistrationConfig, ...options.dynamicClientRegistration });\n`
    : '';
  const dcrStoreImport = features.dynamicClientRegistration
    ? `  dynamicClientStore,
  withDynamicallyRegisteredClients,\n`
    : '';
  const dcrOptionsField = features.dynamicClientRegistration
    ? `  /**
   * EXPERIMENTAL (RFC 7591): override the generated dynamic client registration
   * settings (routes/register.ts) per deployment — for example from environment
   * variables — without editing the generated file. Unset fields keep the
   * generated defaults.
   */
  dynamicClientRegistration?: {
    initialAccessToken?: string;
    maxRegisteredClients?: number;
    maxRegistrationBodyBytes?: number;
  };
`
    : '';
  // EXPERIMENTAL (RFC 7591): the token endpoint resolves clients through its
  // own resolver, so both resolvers get the dynamic registration fallback.
  const clientResolverAssignment = features.dynamicClientRegistration
    ? `    // EXPERIMENTAL (RFC 7591): dynamically registered clients resolve after the
    // configured clients, so a static registration always wins.
    const clientResolver = withDynamicallyRegisteredClients(
      options.clientResolver ?? ${storageParts.defaultClientResolver},
    );`
    : `    const clientResolver =
      options.clientResolver ?? ${storageParts.defaultClientResolver};`;
  const tokenClientResolverContext = features.dynamicClientRegistration
    ? `    c.set('tokenClientResolver', options.tokenClientResolver
      ? withDynamicallyRegisteredClients(options.tokenClientResolver)
      : clientResolver);`
    : `    c.set('tokenClientResolver', options.tokenClientResolver ?? clientResolver);`;
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
${introspectionImport}${revocationImport}${parImport}${deviceImport}${cibaImport}${logoutImport}${dcrImport}import { jwksApp } from './routes/jwks.js';
import { discoveryApp } from './routes/discovery.js';
import { loginPage } from './pages/login.js';
import { consentPage } from './pages/consent.js';
import {
${storageParts.inMemoryClientResolverImport}  createProviderConfig,
  type ProviderConfig,
} from './config.js';
import {
  createStoreResolvers,
} from './resolvers.js';
import {
${storageParts.defaultStoresImport}${parStoreImport}${deviceStoreImport}${cibaStoreImport}${dcrStoreImport}  type ProviderStores,
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
  ClientKeyResolver,
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
${storageParts.clientResolverDoc}  clientResolver?: ClientResolver;
  tokenClientResolver?: TokenClientResolver;
${storageParts.clientKeyResolverDoc}  clientKeyResolver?: ClientKeyResolver;
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
   * acr / amr resolver (OIDC Core 1.0 §2 / §12.1)。
   * Host application が認証ポリシーに合わせて acr / amr を返す。返した acr は ID Token と
   * アクセストークン（RFC 9068 §2.2.1）の両方に載る。
   * 未指定の場合は、要求された acr 値（acr_values）の最優先値を acr とし、amr は含めない。
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
${cibaOptionsField}${dcrOptionsField}${googleLoginOptionsFields}  corsOrigins?: CorsOrigins;
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
${introspectionCors}${revocationCors}${parCors}${deviceCors}${cibaCors}${dcrCors}  app.use('/.well-known/openid-configuration', publicCors);
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
${clientResolverAssignment}
    const stores = await resolveProviderStores(options.storage, c);
    const storeResolvers = createStoreResolvers(stores);

    // T-022: registered key sets per purpose.
    c.set('signingKeys', signingKeys);
    c.set('idTokenSigningKeys', idTokenSigningKeys);
    c.set('userinfoSigningKeys', userinfoSigningKeys);

    c.set('config', createProviderConfig(options.config));
    c.set('clientResolver', clientResolver);
${tokenClientResolverContext}
    c.set('clientKeyResolver', options.clientKeyResolver ?? ${storageParts.defaultClientKeyResolver});
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
${refreshStorageContext}${introspectionStorageContext}${revocationStorageContext}${parStorageContext}${deviceStorageContext}${cibaStorageContext}${dcrStorageContext}${googleLoginStorageContext}
    // T-015: acr / amr resolver (optional; without one, routes/token.ts puts the
    // most preferred requested acr value into the tokens).
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
${introspectionMount}${revocationMount}${parMount}${deviceMount}${cibaMount}${logoutMount}${dcrMount}  app.route('/.well-known/jwks.json', jwksApp);
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
