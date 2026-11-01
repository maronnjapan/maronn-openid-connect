import { defineFeature } from '../../feature';
import { dynamicClientRegistrationConfig } from './config';
import { withDynamicallyRegisteredClientKeys, withDynamicallyRegisteredClients } from './store';

/**
 * Dynamic Client Registration (RFC 7591): app/(dynamic-client-registration)/register/.
 * The clients it issues, and the public keys of their jwks (or of the
 * jwks_uri they named, fetched when needed and cached), resolve after the
 * clients of db/, so a static registration always wins.
 */
export const dynamicClientRegistration = defineFeature({
  id: 'dynamic-client-registration',
  // OIDC Discovery 1.0 §3: registration_endpoint.
  discovery: (issuer) => ({ registration_endpoint: `${issuer}/register` }),
  // Dynamically registered clients, and their keys, resolve after the clients
  // of db/. The settings are read when keys are needed, so what
  // instrumentation.ts puts into dynamicClientRegistrationConfig applies.
  context: ({ clientResolver, clientKeyResolver }) => ({
    clientResolver: withDynamicallyRegisteredClients(clientResolver),
    clientKeyResolver: withDynamicallyRegisteredClientKeys(clientKeyResolver, () => dynamicClientRegistrationConfig),
  }),
});
