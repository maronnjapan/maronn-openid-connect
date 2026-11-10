import { defineFeature } from '../../feature';
import { withDynamicallyRegisteredClientKeys, withDynamicallyRegisteredClients } from './store';

/**
 * Dynamic Client Registration (RFC 7591): app/(dynamic-client-registration)/register/.
 * The clients it issues, and the public keys of their jwks, resolve after the
 * clients of db/, so a static registration always wins.
 */
export const dynamicClientRegistration = defineFeature({
  id: 'dynamic-client-registration',
  // OIDC Discovery 1.0 §3: registration_endpoint.
  discovery: (issuer) => ({ registration_endpoint: `${issuer}/register` }),
  // Dynamically registered clients, and their keys, resolve after the clients of db/.
  context: ({ clientResolver, clientKeyResolver }) => ({
    clientResolver: withDynamicallyRegisteredClients(clientResolver),
    clientKeyResolver: withDynamicallyRegisteredClientKeys(clientKeyResolver),
  }),
});
