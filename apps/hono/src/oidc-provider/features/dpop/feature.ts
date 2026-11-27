import { defineFeature } from '../feature.js';
import { dpopConfigDefaults, dpopSigningAlgsOf } from './config.js';

/**
 * EXTENSION (dpop) — OAuth 2.0 Demonstrating Proof of Possession (RFC 9449).
 * The checks of a DPoP proof are the modules of this directory (proof.ts, with
 * jwk.ts and htu.ts), to be changed here when the policy changes. No pipeline
 * calls them: every token is a Bearer token. The feature adds the defaults of
 * the DPoP settings (dpopConfigDefaults of ./config.ts) to the defaults of
 * ProviderConfig, advertises the algorithms the proof checks accept, and lets
 * browsers send the DPoP header.
 */
export const dpop = defineFeature({
  id: 'dpop',
  config: dpopConfigDefaults,
  // RFC 9449 §5.1: the algorithms the proof checks accept (the configured
  // ones that jwk.ts verifies).
  discovery: (_issuer, config) => ({ dpop_signing_alg_values_supported: [...dpopSigningAlgsOf(config)] }),
  // A browser-based client sends its proof in the DPoP header (RFC 9449 §4.1),
  // and reads the challenges of a failure in WWW-Authenticate (RFC 9449 §7.1).
  cors: { allowHeaders: ['DPoP'], exposeHeaders: ['WWW-Authenticate'] },
});
