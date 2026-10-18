import { defineFeature } from '../../feature';
import { withDynamicallyRegisteredClients } from './store';

/** Dynamic Client Registration (RFC 7591): app/(dynamic-client-registration)/register/. */
export const dynamicClientRegistration = defineFeature({
  id: 'dynamic-client-registration',
  // OIDC Discovery 1.0 §3: registration_endpoint.
  discovery: (issuer) => ({ registration_endpoint: `${issuer}/register` }),
  // Dynamically registered clients resolve after the clients of db/.
  context: ({ clientResolver }) => ({ clientResolver: withDynamicallyRegisteredClients(clientResolver) }),
});
