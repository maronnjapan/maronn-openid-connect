/**
 * The development data of this app, set up when a server instance starts
 * (instrumentation.ts): the clients of OIDC_CLIENTS_JSON (or the E2E
 * defaults) and the development users in the key-value store of
 * app/_oidc-provider/db/, and the feature settings the environment names.
 *
 * The feature settings are shared() objects, the same in instrumentation.ts as
 * in the Route Handlers, so what is set here reaches every request.
 */
import { createDatabase, createProviderStores, registerClient } from './app/_oidc-provider/db';
import { registerDevelopmentUsers } from './app/_oidc-provider/development';
import { extendDynamicClientRegistrationConfig } from './app/_oidc-provider/features/dynamic-client-registration/config';
import { idJagConfig } from './app/_oidc-provider/features/id-jag/config';
import { rpInitiatedLogoutConfig } from './app/_oidc-provider/features/rp-initiated-logout/config';
import {
  readCrossAppAccess,
  readDynamicClientRegistration,
  readPostLogoutRedirectUris,
  readRegisteredClients,
  type Environment,
} from './settings';

export async function registerDevelopmentData(env: Environment = process.env): Promise<void> {
  const db = createDatabase();

  // registerClient() replaces an earlier registration of the same client_id,
  // so a restart picks up changed clients. A client is one record written in
  // one set, so instances that start at the same moment do not conflict.
  for (const client of readRegisteredClients(env['OIDC_CLIENTS_JSON'])) {
    await registerClient(db, client);
  }
  // E2E and the conformance suite sign in as testuser / otheruser (password
  // "password"). A user that is already registered is left as it is.
  await registerDevelopmentUsers(db);

  applyFeatureSettings(env, db);
}

/** The feature settings the environment names; the others keep the defaults of the code. */
export function applyFeatureSettings(env: Environment, db: ReturnType<typeof createDatabase>): void {
  const postLogoutRedirectUris = readPostLogoutRedirectUris(env);
  if (postLogoutRedirectUris) {
    rpInitiatedLogoutConfig.postLogoutRedirectUris = postLogoutRedirectUris;
  }
  extendDynamicClientRegistrationConfig(readDynamicClientRegistration(env));

  const crossAppAccess = readCrossAppAccess(env);
  if (crossAppAccess.allowedAudiences.length > 0) {
    idJagConfig.allowedAudiences = crossAppAccess.allowedAudiences;
  }
  if (crossAppAccess.trustedIdentityProvider) {
    idJagConfig.trustedIdentityProviders = [crossAppAccess.trustedIdentityProvider];
  }
  if (crossAppAccess.allowActorTokens) {
    idJagConfig.allowActorTokens = true;
  }
  // The actor_token extension point: idJagConfig.actorTokenResolver owns the
  // CONTENT validation of every actor_token the OP accepts. This one adds the
  // access tokens this very OP issued, looked up in its own store, and hands
  // every other token type to the default (which validates this OP's ID
  // Tokens). Anything unknown, expired, or issued to a different client
  // resolves to null.
  if (crossAppAccess.actorTokenResolver === 'access-token') {
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
