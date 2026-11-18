import { defineFeature } from '../../feature';
import { dpopConfigDefaults, dpopSigningAlgsOf } from './config';

/**
 * EXTENSION (dpop) — OAuth 2.0 Demonstrating Proof of Possession (RFC 9449).
 * The token endpoint checks the DPoP proof of a request and binds the access
 * token (and a public client's refresh token) to its key; the UserInfo
 * endpoint takes `Authorization: DPoP <token>` with a proof; /authorize binds
 * the authorization code to dpop_jkt (§10), and PAR to the key of its DPoP
 * header (§10.1). The steps are the blocks of the route.ts files that name
 * this feature, and they call the modules of this directory. See
 * @maronn-openid-connect/dpop.
 *
 * This file and config.ts are loaded with the feature list (features.ts),
 * which provider.ts, config.ts and http.ts import, so they import neither
 * provider.ts nor http.ts; the modules the blocks call do.
 */
export const dpop = defineFeature({
  id: 'dpop',
  config: dpopConfigDefaults,
  // RFC 9449 §5.1: the algorithms the OP accepts for DPoP proofs.
  discovery: (_issuer, config) => ({ dpop_signing_alg_values_supported: [...dpopSigningAlgsOf(config)] }),
  // A browser-based client sends its proof in the DPoP header, and reads the
  // DPoP challenge of a failure in WWW-Authenticate (RFC 9449 §7.1).
  cors: { allowHeaders: ['DPoP'], exposeHeaders: ['WWW-Authenticate'] },
});
