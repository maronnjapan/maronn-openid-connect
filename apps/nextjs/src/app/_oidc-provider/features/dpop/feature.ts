import { defineFeature } from '../../feature';
import { dpopConfigDefaults } from './config';

/**
 * EXTENSION (dpop) — OAuth 2.0 Demonstrating Proof of Possession (RFC 9449).
 * The checks of a DPoP proof are the modules of this directory (proof.ts, with
 * jwk.ts and htu.ts), to be changed here when the policy changes. No route
 * calls them: every token is a Bearer token. The feature adds the defaults of
 * the DPoP settings (dpopConfigDefaults of ./config.ts) to the defaults of
 * ProviderConfig and lets browsers send the DPoP header. Discovery does not
 * advertise dpop_signing_alg_values_supported (RFC 9449 §5.1), which signals
 * support for DPoP, while no endpoint checks a DPoP proof.
 *
 * This file and config.ts are loaded with the feature list (features.ts),
 * which provider.ts, config.ts and http.ts import, so they import neither
 * provider.ts nor http.ts. The same holds for the modules config.ts imports
 * (jwk.ts, base64url.ts and errors.ts). proof.ts reads provider.ts, so no
 * file the feature list loads imports it.
 */
export const dpop = defineFeature({
  id: 'dpop',
  config: dpopConfigDefaults,
  // A browser-based client sends its proof in the DPoP header (RFC 9449 §4.1),
  // and reads the challenges of a failure in WWW-Authenticate (RFC 9449 §7.1).
  cors: { allowHeaders: ['DPoP'], exposeHeaders: ['WWW-Authenticate'] },
});
