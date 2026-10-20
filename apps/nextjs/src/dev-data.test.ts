import { hashClientSecret } from '@maronn-openid-connect/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, createProviderStores } from './app/_oidc-provider/db';
import { createClientResolver } from './app/_oidc-provider/db/kv/clients';
import { dynamicClientRegistrationConfig } from './app/_oidc-provider/features/dynamic-client-registration/config';
import { idJagConfig } from './app/_oidc-provider/features/id-jag/config';
import { rpInitiatedLogoutConfig } from './app/_oidc-provider/features/rp-initiated-logout/config';
import { applyFeatureSettings, registerDevelopmentData } from './dev-data';
import { accessTokenInfo } from './test-support/fixtures';
import { createMapKvDatabase } from './test-support/databases';

// registerDevelopmentData() writes to the key-value store of db/ (in memory
// for the tests, vitest.config.ts), which lives for the whole file, so every
// test registers clients of its own. The feature settings are shared()
// objects: each test starts from the defaults of the code.

const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';

const defaults = {
  rpInitiatedLogout: { ...rpInitiatedLogoutConfig },
  dynamicClientRegistration: { ...dynamicClientRegistrationConfig },
  idJag: { ...idJagConfig },
};

afterEach(() => {
  Object.assign(rpInitiatedLogoutConfig, defaults.rpInitiatedLogout);
  Object.assign(dynamicClientRegistrationConfig, defaults.dynamicClientRegistration);
  Object.assign(idJagConfig, defaults.idJag);
  vi.useRealTimers();
});

/** The actor token resolver applyFeatureSettings() left in idJagConfig. */
function actorTokenResolver() {
  return idJagConfig.actorTokenResolver;
}

/** The input idJagConfig.actorTokenResolver gets for an actor_token of the client rp-1. */
function actorInput(actorToken: string, actorTokenType = ACCESS_TOKEN_TYPE) {
  return { actorToken, actorTokenType, clientId: 'rp-1', issuer: 'https://op.example.com', jwks: { keys: [] } };
}

describe('applyFeatureSettings', () => {
  it('should keep the defaults of the code when no variable is set', () => {
    applyFeatureSettings({}, createMapKvDatabase());

    expect(rpInitiatedLogoutConfig).toEqual({ postLogoutRedirectUris: {} });
    expect(dynamicClientRegistrationConfig).toEqual({
      initialAccessToken: undefined,
      maxRegisteredClients: 100,
      maxRegistrationBodyBytes: 16384,
    });
    expect(idJagConfig).toEqual(defaults.idJag);
    expect(idJagConfig.actorTokenResolver).toBe(defaults.idJag.actorTokenResolver);
  });

  // RP-Initiated Logout 1.0 §3: post_logout_redirect_uri values registered per client.
  it('should set the post_logout_redirect_uri registry of OIDC_POST_LOGOUT_REDIRECT_URIS_JSON', () => {
    applyFeatureSettings(
      { OIDC_POST_LOGOUT_REDIRECT_URIS_JSON: '{"rp-1":["https://rp.example.com/logged-out"]}' },
      createMapKvDatabase(),
    );

    expect(rpInitiatedLogoutConfig.postLogoutRedirectUris).toEqual({ 'rp-1': ['https://rp.example.com/logged-out'] });
  });

  // RFC 7591 / OIDC Dynamic Client Registration 1.0 §3: the initial access token and the inventory cap.
  it('should set the initial access token and the cap of OIDC_DCR_INITIAL_ACCESS_TOKEN and OIDC_DCR_MAX_CLIENTS', () => {
    applyFeatureSettings({ OIDC_DCR_INITIAL_ACCESS_TOKEN: 'iat-1', OIDC_DCR_MAX_CLIENTS: '5' }, createMapKvDatabase());

    expect(dynamicClientRegistrationConfig).toEqual({
      initialAccessToken: 'iat-1',
      maxRegisteredClients: 5,
      maxRegistrationBodyBytes: 16384,
    });
  });

  it('should set the audiences an ID-JAG may be issued for from XAA_ALLOWED_AUDIENCES', () => {
    applyFeatureSettings({ XAA_ALLOWED_AUDIENCES: 'https://as.example.com, https://as2.example.com' }, createMapKvDatabase());

    expect(idJagConfig.allowedAudiences).toEqual(['https://as.example.com', 'https://as2.example.com']);
  });

  // ID-JAG draft §4.4: the identity provider whose ID-JAGs the jwt-bearer grant accepts.
  it('should trust the identity provider of XAA_TRUSTED_IDP_ISSUER with the JWKS at its well-known location', () => {
    applyFeatureSettings({ XAA_TRUSTED_IDP_ISSUER: 'https://idp.example.com' }, createMapKvDatabase());

    expect(idJagConfig.trustedIdentityProviders).toEqual([
      { issuer: 'https://idp.example.com', jwksUri: 'https://idp.example.com/.well-known/jwks.json' },
    ]);
  });

  it('should accept actor tokens when XAA_ALLOW_ACTOR_TOKENS is 1', () => {
    applyFeatureSettings({ XAA_ALLOW_ACTOR_TOKENS: '1' }, createMapKvDatabase());

    expect(idJagConfig.allowActorTokens).toBe(true);
  });

  // RFC 8693 §4.1: XAA_ACTOR_TOKEN_RESOLVER=access-token resolves actor tokens
  // that are access tokens this OP issued, looked up in its own store.
  describe('Access Token Actor Resolver', () => {
    it('should resolve an access token this OP issued to the client to its subject', async () => {
      const db = createMapKvDatabase();
      await createProviderStores(db).accessTokenStore.set('actor-at', accessTokenInfo({ sub: 'agent-1', clientId: 'rp-1' }));

      applyFeatureSettings({ XAA_ACTOR_TOKEN_RESOLVER: 'access-token' }, db);

      expect(await actorTokenResolver()?.(actorInput('actor-at'))).toEqual({ sub: 'agent-1' });
    });

    it('should resolve an access token issued to another client to null', async () => {
      const db = createMapKvDatabase();
      await createProviderStores(db).accessTokenStore.set('actor-at', accessTokenInfo({ sub: 'agent-1', clientId: 'rp-2' }));

      applyFeatureSettings({ XAA_ACTOR_TOKEN_RESOLVER: 'access-token' }, db);

      expect(await actorTokenResolver()?.(actorInput('actor-at'))).toBeNull();
    });

    it('should resolve an access token that has expired to null', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.UTC(2026, 0, 1));
      const db = createMapKvDatabase();
      await createProviderStores(db).accessTokenStore.set(
        'actor-at',
        accessTokenInfo({ sub: 'agent-1', clientId: 'rp-1', expiresAt: Date.UTC(2026, 0, 1) / 1000 + 60 }),
      );
      applyFeatureSettings({ XAA_ACTOR_TOKEN_RESOLVER: 'access-token' }, db);
      vi.setSystemTime(Date.UTC(2026, 0, 1) + 60_000);

      expect(await actorTokenResolver()?.(actorInput('actor-at'))).toBeNull();
    });

    it('should resolve an access token the OP does not know to null', async () => {
      applyFeatureSettings({ XAA_ACTOR_TOKEN_RESOLVER: 'access-token' }, createMapKvDatabase());

      expect(await actorTokenResolver()?.(actorInput('actor-at-unknown'))).toBeNull();
    });

    it('should hand an actor token of another type to the resolver that was set before', async () => {
      const previous = vi.fn(async () => ({ sub: 'from-id-token' }));
      idJagConfig.actorTokenResolver = previous;

      applyFeatureSettings({ XAA_ACTOR_TOKEN_RESOLVER: 'access-token' }, createMapKvDatabase());
      const actor = await actorTokenResolver()?.(actorInput('actor-id-token', ID_TOKEN_TYPE));

      expect(actor).toEqual({ sub: 'from-id-token' });
      expect(previous).toHaveBeenCalledWith(actorInput('actor-id-token', ID_TOKEN_TYPE));
    });

    it('should resolve an actor token of another type to null when no resolver was set before', async () => {
      idJagConfig.actorTokenResolver = undefined;

      applyFeatureSettings({ XAA_ACTOR_TOKEN_RESOLVER: 'access-token' }, createMapKvDatabase());

      expect(await actorTokenResolver()?.(actorInput('actor-id-token', ID_TOKEN_TYPE))).toBeNull();
    });
  });
});

describe('registerDevelopmentData', () => {
  it('should register the clients of OIDC_CLIENTS_JSON in the database', async () => {
    const clients = [
      {
        clientId: 'dev-data-rp',
        clientSecret: 'dev-data-secret',
        redirectUris: ['https://rp.example.com/cb'],
        grantTypes: ['authorization_code', 'refresh_token'],
        tokenEndpointAuthMethods: ['client_secret_basic'],
      },
    ];

    await registerDevelopmentData({ OIDC_CLIENTS_JSON: JSON.stringify(clients) });

    expect(await createClientResolver(createDatabase()).findClient('dev-data-rp')).toEqual({
      clientId: 'dev-data-rp',
      clientType: 'confidential',
      redirectUris: ['https://rp.example.com/cb'],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethods: ['client_secret_basic'],
      clientSecretHash: await hashClientSecret('dev-data-secret'),
    });
  });

  it('should register the two clients of tests/e2e when OIDC_CLIENTS_JSON is unset', async () => {
    await registerDevelopmentData({});

    const resolver = createClientResolver(createDatabase());
    expect(await resolver.findClient('e2e-client')).toEqual({
      clientId: 'e2e-client',
      clientType: 'confidential',
      redirectUris: ['http://127.0.0.1:3020/callback'],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethods: ['client_secret_post'],
      responseTypes: ['code'],
      clientSecretHash: await hashClientSecret('e2e-client-secret'),
    });
    expect(await resolver.findClient('e2e-resource-server')).toEqual({
      clientId: 'e2e-resource-server',
      clientType: 'confidential',
      redirectUris: ['http://127.0.0.1:3030/unused-callback'],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethods: ['client_secret_basic'],
      responseTypes: ['code'],
      clientSecretHash: await hashClientSecret('e2e-resource-server-secret'),
    });
  });

  it('should replace a client registered by an earlier start', async () => {
    const client = { clientId: 'dev-data-changed', redirectUris: ['https://rp.example.com/old'] };
    await registerDevelopmentData({ OIDC_CLIENTS_JSON: JSON.stringify([client]) });

    await registerDevelopmentData({
      OIDC_CLIENTS_JSON: JSON.stringify([{ ...client, redirectUris: ['https://rp.example.com/new'] }]),
    });

    expect(await createClientResolver(createDatabase()).findClient('dev-data-changed')).toMatchObject({
      redirectUris: ['https://rp.example.com/new'],
    });
  });

  // E2E and the conformance suite sign in as testuser / otheruser.
  it('should register testuser and otheruser with the password "password"', async () => {
    await registerDevelopmentData({ OIDC_CLIENTS_JSON: '[]' });

    const { userStore } = createProviderStores(createDatabase());
    expect(await userStore.authenticate('testuser', 'password')).toMatchObject({ sub: 'testuser' });
    expect(await userStore.authenticate('otheruser', 'password')).toMatchObject({ sub: 'otheruser' });
  });

  it('should apply the feature settings of the environment it is given', async () => {
    await registerDevelopmentData({ OIDC_CLIENTS_JSON: '[]', OIDC_DCR_MAX_CLIENTS: '7' });

    expect(dynamicClientRegistrationConfig.maxRegisteredClients).toBe(7);
  });
});
