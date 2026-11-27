import { defineFeature } from '../feature.js';
import { dpopConfigDefaults, dpopSigningAlgsOf } from './config.js';

/**
 * EXTENSION (dpop) — OAuth 2.0 Demonstrating Proof of Possession (RFC 9449).
 * The token endpoint checks the DPoP proof of a request (the
 * [verify-dpop-proof] block of endpoints/token/pipeline.ts, whose step is
 * steps/verify-dpop-proof.ts) and binds the access token it issues, and the
 * refresh token of a public client, to the key of the proof (cnf.jkt,
 * token_type DPoP); the [validate-dpop-grant-binding] block after it
 * (steps/validate-dpop-grant-binding.ts) lets a code or refresh token bound
 * to a key be used only with a proof of that key. A request without a DPoP
 * header gets Bearer tokens, unless its client is registered with
 * dpopBoundAccessTokens (dpop_bound_access_tokens, ./config.ts): the
 * [verify-dpop-proof] block rejects it then. The UserInfo endpoint takes a
 * token presented with the DPoP scheme and its proof (the
 * [read-dpop-access-token] block of endpoints/userinfo/pipeline.ts) and lets
 * a bound token be used only with a proof of its key, never as a Bearer token
 * ([verify-dpop-access-token]).
 * The authorization endpoint reads the dpop_jkt of a request (the
 * [validate-dpop-jkt] block of endpoints/authorize/pipeline.ts, whose step is
 * steps/validate-dpop-jkt.ts) and binds the code issued for it to that key.
 * With par, the PAR endpoint checks the DPoP proof of a pushed request (the
 * [bind-pushed-dpop-key] block of features/par/endpoints/par/pipeline.ts,
 * whose step is steps/bind-pushed-dpop-key.ts) and pushes the request with
 * the key of the proof as its dpop_jkt.
 * With dynamic-client-registration, the client registration endpoint
 * registers dpop_bound_access_tokens (the [validate-dpop-client-metadata]
 * block of features/dynamic-client-registration/endpoints/register/pipeline.ts,
 * whose step is steps/validate-dpop-client-metadata.ts), which the
 * [verify-dpop-proof] block reads from the registered metadata.
 * With dpopNonceRequiredAtAuthorizationServer (./config.ts), the
 * [require-dpop-nonce] block of the token endpoint and the
 * [require-pushed-dpop-nonce] block of the PAR endpoint, before client
 * authentication (steps/require-dpop-nonce.ts and
 * steps/require-pushed-dpop-nonce.ts, which call server-nonce.ts), give every
 * response from then on to a request with a DPoP header a new nonce of the
 * authorization server (DPoP-Nonce) and reject a proof without a nonce it
 * recently provided (use_dpop_nonce).
 * The checks it calls are the modules of this directory (proof.ts, with
 * jwk.ts and htu.ts, binding.ts and resource.ts), to be changed here when the
 * policy changes. proof.ts also checks the nonce of a proof (nonce.ts) for an
 * endpoint that passes the server whose nonce it requires. The feature adds
 * the defaults of the DPoP settings (dpopConfigDefaults of ./config.ts) to
 * the defaults of ProviderConfig, puts the secret of the DPoP nonces into the
 * request context, advertises the algs of the checks in discovery and lets
 * browsers send the DPoP header and read the DPoP-Nonce header.
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
  // The secret of the DPoP nonces (OidcProviderOptions.dpopNonceSecret of
  // ./config.ts), read by the nonce check of proof.ts.
  context: ({ options }) => ({ dpopNonceSecret: options.dpopNonceSecret }),
  // A browser-based client sends its proof in the DPoP header (RFC 9449 §4.1),
  // reads the challenges of a failure in WWW-Authenticate (RFC 9449 §7.1) and
  // the nonce to put in its next proof in DPoP-Nonce (RFC 9449 §8).
  cors: { allowHeaders: ['DPoP'], exposeHeaders: ['WWW-Authenticate', 'DPoP-Nonce'] },
});
