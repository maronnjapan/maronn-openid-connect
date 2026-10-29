import { defineFeature } from '../feature.js';
import { dynamicClientRegistrationConfig, extendDynamicClientRegistrationConfig } from './config.js';
import { registerApp } from './endpoints/register/pipeline.js';
import {
  dynamicClientStore,
  withDynamicallyRegisteredClientKeys,
  withDynamicallyRegisteredClients,
} from './store.js';

/**
 * EXPERIMENTAL — OAuth 2.0 Dynamic Client Registration (RFC 7591): POST
 * /register. The clients it issues are kept in an in-memory store
 * (store.ts) and resolved after the configured clients, so a static
 * registration always wins; the public keys a registration carried (jwks)
 * are handed out by the ClientKeyResolver the same way. Registration
 * management (RFC 7592) is not implemented. The settings, the optional
 * verifier functions (initial access token, software statement) and the
 * custom metadata are in config.ts.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it
 * may change in a breaking way between releases.
 */
export const dynamicClientRegistration = defineFeature({
  id: 'dynamic-client-registration',
  routes: [{ path: '/register', app: registerApp, methods: ['POST'], cors: 'protected' }],
  // OIDC Discovery 1.0 §3: registration_endpoint.
  discovery: (issuer) => ({ registration_endpoint: `${issuer}/register` }),
  context: ({ c, options }) => ({
    dynamicClientStore,
    dynamicClientRegistrationConfig: extendDynamicClientRegistrationConfig(dynamicClientRegistrationConfig, options.dynamicClientRegistration),
    // Dynamically registered clients, and their keys, resolve after the configured clients.
    clientResolver: withDynamicallyRegisteredClients(c.get('clientResolver')),
    tokenClientResolver: withDynamicallyRegisteredClients(c.get('tokenClientResolver')),
    clientKeyResolver: withDynamicallyRegisteredClientKeys(c.get('clientKeyResolver')),
  }),
});
