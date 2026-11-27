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
 * DPoP header gets Bearer tokens, unless its client is registered with
 * dpopBoundAccessTokens (dpop_bound_access_tokens, ./config.ts): the
 * [verify-dpop-proof] block rejects it then. The UserInfo endpoint takes a
 * token presented with the DPoP scheme and its proof (the
 * [read-dpop-access-token] block of userinfo/route.ts, which calls
 * ./userinfo.ts) and lets a bound token be used only with a proof of its key,
 * never as a Bearer token ([verify-dpop-access-token]). The authorization
 * endpoint reads the dpop_jkt of a request (the [validate-dpop-jkt] block of
 * authorize/route.ts, which calls ./authorize.ts) and binds the code issued
 * for it to that key.
 * With par, the PAR endpoint checks the DPoP proof of a pushed request (the
 * [bind-pushed-dpop-key] block of (par)/par/route.ts, which calls ./par.ts)
 * and pushes the request with the key of the proof as its dpop_jkt.
 * With dynamic-client-registration, the client registration endpoint
 * registers dpop_bound_access_tokens (the [validate-dpop-client-metadata]
 * block of (dynamic-client-registration)/register/route.ts, which calls
 * ./register.ts), which the [verify-dpop-proof] block reads from the
 * registered metadata.
 * With dpopNonceRequiredAtAuthorizationServer (./config.ts; the environment
 * variable OIDC_DPOP_NONCE_REQUIRED_AT_AUTHORIZATION_SERVER=1), the
 * [require-dpop-nonce] block of token/route.ts and the
 * [require-pushed-dpop-nonce] block of (par)/par/route.ts, before client
 * authentication (./token.ts and ./par.ts, which call ./server-nonce.ts),
 * give every response from then on to a request with a DPoP header a new
 * nonce of the authorization server (DPoP-Nonce) and reject a proof without a
 * nonce it recently provided (use_dpop_nonce). With
 * dpopNonceRequiredAtResourceServer (the environment variable
 * OIDC_DPOP_NONCE_REQUIRED_AT_RESOURCE_SERVER=1), the
 * [read-dpop-access-token] block of userinfo/route.ts does the same with the
 * nonces of the protected resource for a request presented with the DPoP
 * scheme (./userinfo.ts, which calls ./server-nonce.ts).
 * The checks it calls are the modules of this directory (proof.ts, with
 * jwk.ts and htu.ts, binding.ts and resource.ts), to be changed here when the
 * policy changes. proof.ts also checks the nonce of a proof (nonce.ts, with
 * the secret of the environment variable OIDC_DPOP_NONCE_SECRET) for an
 * endpoint that passes the server whose nonce it requires. The feature adds
 * the defaults of the DPoP settings (dpopConfigDefaults of ./config.ts) to
 * the defaults of ProviderConfig, advertises the algs of the checks in
 * discovery and lets browsers send the DPoP header and read the DPoP-Nonce
 * header.
 *
 * This file and config.ts are loaded with the feature list (features.ts),
 * which provider.ts, config.ts and http.ts import, so they import neither
 * provider.ts nor http.ts. The same holds for the modules config.ts imports
 * (jwk.ts, base64url.ts and errors.ts). proof.ts reads provider.ts,
 * error-responses.ts imports http.ts and server-nonce.ts imports both, so no
 * file the feature list loads imports them, or token.ts, par.ts and
 * userinfo.ts, which import all three: token/route.ts, userinfo/route.ts and
 * (par)/par/route.ts do. nonce.ts
 * imports base64url.ts and shared.ts only; only proof.ts and server-nonce.ts
 * import it.
 * register.ts imports nothing; only
 * (dynamic-client-registration)/register/route.ts imports it.
 */
export const dpop = defineFeature({
  id: 'dpop',
  config: {
    ...dpopConfigDefaults,
    // RFC 9449 §8: OIDC_DPOP_NONCE_REQUIRED_AT_AUTHORIZATION_SERVER=1 makes the
    // token and PAR endpoints require a nonce of the authorization server in
    // every DPoP proof.
    dpopNonceRequiredAtAuthorizationServer: process.env.OIDC_DPOP_NONCE_REQUIRED_AT_AUTHORIZATION_SERVER === '1',
    // RFC 9449 §9: OIDC_DPOP_NONCE_REQUIRED_AT_RESOURCE_SERVER=1 makes the
    // UserInfo endpoint require a nonce of the protected resource in every
    // DPoP proof.
    dpopNonceRequiredAtResourceServer: process.env.OIDC_DPOP_NONCE_REQUIRED_AT_RESOURCE_SERVER === '1',
  },
  // RFC 9449 §5.1: the algs the checks accept for DPoP proofs, which signals
  // support for DPoP. Left out when none of the configured algs is verifiable,
  // since an empty list would signal support with no usable alg.
  discovery: (_issuer, config) => {
    const algs = dpopSigningAlgsOf(config);
    return algs.length === 0 ? {} : { dpop_signing_alg_values_supported: [...algs] };
  },
  // A browser-based client sends its proof in the DPoP header (RFC 9449 §4.1),
  // reads the challenges of a failure in WWW-Authenticate (RFC 9449 §7.1) and
  // the nonce to put in its next proof in DPoP-Nonce (RFC 9449 §8).
  cors: { allowHeaders: ['DPoP'], exposeHeaders: ['WWW-Authenticate', 'DPoP-Nonce'] },
});
