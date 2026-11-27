/**
 * EXTENSION (dpop): the settings of OAuth 2.0 Demonstrating Proof of
 * Possession (RFC 9449), added to ProviderConfig (config.ts), and their
 * defaults (dpopConfigDefaults), to be laid over the defaults of config.ts.
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
     * accepted (RFC 9449 §11.1), not counting dpopProofLeewaySeconds. Its
     * default is dpopConfigDefaults (60).
     */
    dpopProofMaxAgeSeconds: number;
    /**
     * EXTENSION (dpop): the seconds of clock skew allowed for the iat of a
     * DPoP proof, both into the future and added to dpopProofMaxAgeSeconds
     * (RFC 9449 §11.1). Its default is dpopConfigDefaults (60).
     */
    dpopProofLeewaySeconds: number;
  }
}

/** The defaults of the DPoP settings, to be laid over the defaults of config.ts. */
export const dpopConfigDefaults = {
  // RFC 9449 §5.1: every alg the checks of jwk.ts verify.
  dpopSigningAlgValuesSupported: [...SUPPORTED_DPOP_SIGNING_ALGS],
  // RFC 9449 §11.1: a proof is accepted from 60 seconds before its iat until 120 seconds after it.
  dpopProofMaxAgeSeconds: 60,
  dpopProofLeewaySeconds: 60,
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
