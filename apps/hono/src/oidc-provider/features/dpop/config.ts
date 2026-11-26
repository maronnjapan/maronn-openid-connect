/**
 * EXTENSION (dpop): the settings of OAuth 2.0 Demonstrating Proof of
 * Possession (RFC 9449) and the client metadata it reads.
 */
import type { ProviderConfig } from '../../config.js';
import { SUPPORTED_DPOP_SIGNING_ALGS } from './jwk.js';

declare module '../../config.js' {
  interface ProviderConfig {
    /**
     * EXTENSION (dpop): the JWS algorithms the OP accepts for DPoP proofs,
     * advertised as dpop_signing_alg_values_supported (RFC 9449 §5.1) and in
     * the algs of the DPoP challenge of the UserInfo endpoint (§7.1).
     * Asymmetric algorithms only; an alg the checks of features/dpop/ do not
     * verify (SUPPORTED_DPOP_SIGNING_ALGS) is never accepted, even when listed.
     */
    dpopSigningAlgValuesSupported?: readonly string[];
    /** EXTENSION (dpop): seconds after its iat a DPoP proof is still accepted (RFC 9449 §11.1). */
    dpopProofMaxAgeSeconds?: number;
    /** EXTENSION (dpop): seconds of clock skew allowed for the iat of a DPoP proof. */
    dpopProofLeewaySeconds?: number;
  }

  interface RegisteredClient {
    /**
     * EXTENSION (dpop): dpop_bound_access_tokens (RFC 9449 §5.2). true makes
     * the token endpoint reject every token request of the client that has no
     * DPoP proof. Kept by the memory database and by a clientResolver of your
     * own; the SQL and KV databases have no column for it.
     */
    dpopBoundAccessTokens?: boolean;
  }
}

/** The defaults of the DPoP settings, applied over the defaults of config.ts. */
export const dpopConfigDefaults: Partial<ProviderConfig> = {
  dpopSigningAlgValuesSupported: [...SUPPORTED_DPOP_SIGNING_ALGS],
  dpopProofMaxAgeSeconds: 60,
  dpopProofLeewaySeconds: 60,
};

/**
 * OP が DPoP proof に受け付ける alg を返す。
 *
 * 設定の `dpopSigningAlgValuesSupported` を返し、設定がなければこのディレクトリの検査が検証できるすべての alg（`SUPPORTED_DPOP_SIGNING_ALGS`）を返す。
 *
 * @spec RFC 9449 §5.1
 */
export function dpopSigningAlgsOf(config: ProviderConfig): readonly string[] {
  return config.dpopSigningAlgValuesSupported ?? SUPPORTED_DPOP_SIGNING_ALGS;
}
