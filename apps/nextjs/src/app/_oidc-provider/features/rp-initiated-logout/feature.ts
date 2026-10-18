import { defineFeature } from '../../feature';

/** RP-Initiated Logout 1.0: app/(rp-initiated-logout)/logout/. */
export const rpInitiatedLogout = defineFeature({
  id: 'rp-initiated-logout',
  // RP-Initiated Logout 1.0 §2.1 metadata.
  discovery: (issuer) => ({ end_session_endpoint: `${issuer}/logout` }),
});
