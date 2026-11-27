import { defineFeature } from '../../feature';
import { dpopConfigDefaults, dpopSigningAlgsOf } from './config';

/**
 * EXTENSION (dpop) — OAuth 2.0 Demonstrating Proof of Possession (RFC 9449).
 * The token endpoint checks the DPoP proof of a request (the
 * [verify-dpop-proof] block of token/route.ts, which calls ./token.ts) and
 * binds the access token it issues, and the refresh token of a public client,
 * to the key of the proof (cnf.jkt, token_type DPoP); the
 * [validate-dpop-grant-binding] block after it lets a code or refresh token
 * bound to a key be used only with a proof of that key. A request without a
 * DPoP header gets Bearer tokens. The UserInfo endpoint takes a token
 * presented with the DPoP scheme and its proof (the [read-dpop-access-token]
 * block of userinfo/route.ts, which calls ./userinfo.ts) and lets a bound
 * token be used only with a proof of its key, never as a Bearer token
 * ([verify-dpop-access-token]). The authorization endpoint reads the
 * dpop_jkt of a request (the [validate-dpop-jkt] block of authorize/route.ts,
 * which calls ./authorize.ts) and binds the code issued for it to that key.
 * The checks it calls are the modules of this
 * directory (proof.ts, with jwk.ts and htu.ts, binding.ts and resource.ts), to
 * be changed here when the policy changes. The feature adds the defaults of the DPoP
 * settings (dpopConfigDefaults of ./config.ts) to the defaults of
 * ProviderConfig, advertises the algs of the checks in discovery and lets
 * browsers send the DPoP header.
 *
 * This file and config.ts are loaded with the feature list (features.ts),
 * which provider.ts, config.ts and http.ts import, so they import neither
 * provider.ts nor http.ts. The same holds for the modules config.ts imports
 * (jwk.ts, base64url.ts and errors.ts). proof.ts reads provider.ts and
 * error-responses.ts imports http.ts, so no file the feature list loads
 * imports them, token.ts or userinfo.ts, which import both: token/route.ts
 * and userinfo/route.ts do.
 */
export const dpop = defineFeature({
  id: 'dpop',
  config: dpopConfigDefaults,
  // RFC 9449 §5.1: the algs the checks accept for DPoP proofs, which signals
  // support for DPoP. Left out when none of the configured algs is verifiable,
  // since an empty list would signal support with no usable alg.
  discovery: (_issuer, config) => {
    const algs = dpopSigningAlgsOf(config);
    return algs.length === 0 ? {} : { dpop_signing_alg_values_supported: [...algs] };
  },
  // A browser-based client sends its proof in the DPoP header (RFC 9449 §4.1),
  // and reads the challenges of a failure in WWW-Authenticate (RFC 9449 §7.1).
  cors: { allowHeaders: ['DPoP'], exposeHeaders: ['WWW-Authenticate'] },
});
