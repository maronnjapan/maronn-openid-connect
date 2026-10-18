/**
 * The app: an OpenID Provider on Hono, with every feature of oidc-provider/,
 * its data in the memory of the process.
 *
 * oidc-provider/ is the code `maronn-oidc generate hono` copies into a
 * project; this file and server.ts are how this app uses it, the way a
 * project would.
 */
import { Hono } from 'hono';
import { applyOidc } from './oidc-provider/apply.js';
import { createDatabase, createProviderStores, registerClient } from './oidc-provider/db/index.js';
import { registerDevelopmentUsers } from './oidc-provider/development.js';
import { idJagConfig } from './oidc-provider/features/id-jag/config.js';
import { rpInitiatedLogoutConfig } from './oidc-provider/features/rp-initiated-logout/config.js';
import { createOperatorApp } from './operator.js';
import {
  createEphemeralSigningKeyProvider,
  echoRequestedAcr,
  readCrossAppAccess,
  readDynamicClientRegistration,
  readPostLogoutRedirectUris,
  readRegisteredClients,
  readServerAddress,
  type Environment,
} from './settings.js';

/** Build the app for an environment, and register its clients and the development users. */
export async function createServerApp(env: Environment): Promise<Hono> {
  const { issuer } = readServerAddress(env);
  const db = createDatabase();

  // registerClient() replaces an earlier registration of the same client_id.
  for (const client of readRegisteredClients(env['OIDC_CLIENTS_JSON'])) {
    await registerClient(db, client);
  }
  // tests/e2e and the conformance suite sign in as testuser / otheruser.
  await registerDevelopmentUsers(db);

  const postLogoutRedirectUris = readPostLogoutRedirectUris(env);
  if (postLogoutRedirectUris) {
    rpInitiatedLogoutConfig.postLogoutRedirectUris = postLogoutRedirectUris;
  }
  applyCrossAppAccess(env, db);

  const app = new Hono();
  app.get('/', (c) => c.text('maronn-openid-connect Hono app'));
  app.get('/health', (c) => c.json({ status: 'ok' }));
  const operatorToken = env['APP_OPERATOR_TOKEN'];
  if (operatorToken) {
    app.route('/operator', createOperatorApp(db, operatorToken));
  }

  const googleClientId = env['GOOGLE_CLIENT_ID'];
  applyOidc(app, {
    config: {
      issuer,
      allowNonPkceAuthorizationCodeFlow: env['OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW'] === '1',
      allowUnsignedRequestObject: env['OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT'] === '1',
      // EXTENSION (google-login): the button appears once a Google OAuth
      // client ID is configured.
      ...(googleClientId ? { googleLogin: { clientId: googleClientId } } : {}),
    },
    signingKeyProvider: createEphemeralSigningKeyProvider(env['OIDC_SIGNING_KEY_ID'] ?? 'app-hono-rs256-key'),
    acrResolver: echoRequestedAcr,
    dynamicClientRegistration: readDynamicClientRegistration(env),
    corsOrigins: issuer,
  });
  return app;
}

/**
 * EXPERIMENTAL (Cross-App Access / ID-JAG): with the variables unset the
 * fail-safe defaults of features/id-jag/config.ts stay: no ID-JAG is issued
 * and none is accepted.
 */
function applyCrossAppAccess(env: Environment, db: ReturnType<typeof createDatabase>): void {
  const settings = readCrossAppAccess(env);
  if (settings.allowedAudiences.length > 0) {
    idJagConfig.allowedAudiences = settings.allowedAudiences;
  }
  if (settings.trustedIdentityProvider) {
    idJagConfig.trustedIdentityProviders = [settings.trustedIdentityProvider];
  }
  if (settings.allowActorTokens) {
    idJagConfig.allowActorTokens = true;
  }
  // The actor_token extension point: idJagConfig.actorTokenResolver owns the
  // CONTENT validation of every actor_token the OP accepts. This one adds the
  // access tokens this very OP issued, looked up in its own store, and hands
  // every other token type to the default (which validates this OP's ID
  // Tokens). Anything unknown, expired, or issued to a different client
  // resolves to null.
  if (settings.actorTokenResolver === 'access-token') {
    const defaultResolver = idJagConfig.actorTokenResolver;
    const { accessTokenStore } = createProviderStores(db);
    idJagConfig.actorTokenResolver = async (input) => {
      if (input.actorTokenType === 'urn:ietf:params:oauth:token-type:access_token') {
        const info = await accessTokenStore.get(input.actorToken);
        if (info === undefined || info.clientId !== input.clientId) return null;
        if (info.expiresAt <= Math.floor(Date.now() / 1000)) return null;
        return { sub: info.sub };
      }
      return defaultResolver === undefined ? null : defaultResolver(input);
    };
  }
}
