/**
 * EXTENSION (dpop): the settings of OAuth 2.0 Demonstrating Proof of
 * Possession (RFC 9449), added to ProviderConfig (config.ts), and their
 * defaults (dpopConfigDefaults), to be laid over the defaults of config.ts;
 * the client metadata of DPoP, added to RegisteredClient; and the secret of
 * the DPoP nonces, added to OidcProviderOptions (app.ts).
 */
import type { ProviderConfig } from '../../config.js';
import { isSupportedDpopSigningAlg, SUPPORTED_DPOP_SIGNING_ALGS, type DpopSigningAlg } from './jwk.js';

declare module '../../config.js' {
  interface ProviderConfig {
    /**
     * EXTENSION (dpop): the JWS algorithms a DPoP proof may be signed with
     * (RFC 9449 §4.3), the values of dpop_signing_alg_values_supported (§5.1).
     * Asymmetric algorithms only (§11.6). An alg the checks of jwk.ts do not
     * verify (SUPPORTED_DPOP_SIGNING_ALGS) is left out by dpopSigningAlgsOf(),
     * even when listed here. Its default, every alg of
     * SUPPORTED_DPOP_SIGNING_ALGS, is dpopConfigDefaults; set ['ES256'] to
     * accept ES256 only.
     */
    dpopSigningAlgValuesSupported: readonly string[];
    /**
     * EXTENSION (dpop): the seconds after its iat a DPoP proof is still
     * accepted (RFC 9449 §11.1), not counting dpopProofLeewaySeconds. A
     * non-negative finite number: otherwise the proof checks throw an Error
     * and accept no proof. Its default is dpopConfigDefaults (60).
     */
    dpopProofMaxAgeSeconds: number;
    /**
     * EXTENSION (dpop): the seconds of clock skew allowed for the iat of a
     * DPoP proof, both into the future and added to dpopProofMaxAgeSeconds
     * (RFC 9449 §11.1). A non-negative finite number: otherwise the proof
     * checks throw an Error and accept no proof. Its default is
     * dpopConfigDefaults (60).
     */
    dpopProofLeewaySeconds: number;
    /**
     * EXTENSION (dpop): the seconds after it was issued a DPoP nonce of this
     * OP is still accepted (RFC 9449 §8 / §9): the window of recent nonces
     * the proof checks accept where an endpoint requires a nonce. The nonce
     * carries the second it was issued, so the window holds whatever the
     * clock of the client says (RFC 9449 §11.1). A non-negative finite
     * number: otherwise the nonce check throws an Error and accepts no
     * nonce. Its default is dpopConfigDefaults (120).
     */
    dpopNonceLifetimeSeconds: number;
    /**
     * EXTENSION (dpop): whether the authorization server of this OP (the
     * token endpoint and the PAR endpoint) requires a nonce it provided in
     * the DPoP proofs (RFC 9449 §8). true: once the endpoint has parsed a
     * request with one DPoP header, every response to it carries a new nonce
     * in the DPoP-Nonce header (an answer given before that, such as the 400
     * for a malformed request body, carries none), and a proof without a
     * nonce, or with one the authorization server did not provide within
     * dpopNonceLifetimeSeconds, is rejected with use_dpop_nonce (400).
     * false: no DPoP-Nonce header is sent, and the nonce claim of a proof is
     * not checked. Its default is dpopConfigDefaults (false).
     */
    dpopNonceRequiredAtAuthorizationServer: boolean;
  }

  interface RegisteredClient {
    /**
     * EXTENSION (dpop): the dpop_bound_access_tokens client metadata
     * (RFC 9449 §5.2). true says the client always uses DPoP, so the token
     * endpoint rejects every token request of the client that has no DPoP
     * header (invalid_dpop_proof). Omitted means false: the client may also
     * ask for Bearer tokens. The memory database keeps it with the client,
     * the SQL and key-value databases in the payload of the client. A client
     * registered through POST /register (dynamic-client-registration) has it
     * as dpop_bound_access_tokens in registrationMetadata instead.
     */
    dpopBoundAccessTokens?: boolean;
  }
}

declare module '../../app.js' {
  interface OidcProviderOptions {
    /**
     * EXTENSION (dpop): the secret the DPoP nonces of this OP are signed with
     * (HMAC-SHA256, nonce.ts), at least 32 bytes of UTF-8. Give every
     * instance of the provider the same secret, so that each accepts the
     * nonces of the others. Left out, each instance makes a random key of its
     * own (each isolate on Workers; each Node.js process of Hono, Express or
     * Fastify), which the other instances and the instance after a restart do
     * not have: only a single long-lived instance accepts its nonces then.
     */
    dpopNonceSecret?: string;
  }
}

/** The defaults of the DPoP settings, to be laid over the defaults of config.ts. */
export const dpopConfigDefaults = {
  // RFC 9449 §5.1: every alg the checks of jwk.ts verify.
  dpopSigningAlgValuesSupported: [...SUPPORTED_DPOP_SIGNING_ALGS],
  // RFC 9449 §11.1: a proof is accepted from 60 seconds before its iat until 120 seconds after it.
  dpopProofMaxAgeSeconds: 60,
  dpopProofLeewaySeconds: 60,
  // RFC 9449 §8: a nonce of this OP is accepted for 120 seconds after it was issued.
  dpopNonceLifetimeSeconds: 120,
  // RFC 9449 §8: the authorization server provides no nonce and requires none.
  dpopNonceRequiredAtAuthorizationServer: false,
} satisfies Partial<ProviderConfig>;

/**
 * DPoP proof の署名に受け付ける alg を、設定の順に返す。
 *
 * 設定の `dpopSigningAlgValuesSupported` のうち、`jwk.ts` が署名を検証できる alg（`SUPPORTED_DPOP_SIGNING_ALGS`）だけを返す。
 * 検証できない alg（`none`、`HS256` のような MAC、この実装にない `ES256K` など）は、設定に挙げても返さない。
 * 設定に二度挙げた alg は、最初の位置に一度だけ返す。
 * 返す値は、DPoP proof の `alg` の検査と、`dpop_signing_alg_values_supported` に使う値である。
 *
 * @spec RFC 9449 §4.3
 * @spec RFC 9449 §5.1
 * @spec RFC 9449 §11.6
 */
export function dpopSigningAlgsOf(config: Pick<ProviderConfig, 'dpopSigningAlgValuesSupported'>): readonly DpopSigningAlg[] {
  return [...new Set(config.dpopSigningAlgValuesSupported)].filter(isSupportedDpopSigningAlg);
}
