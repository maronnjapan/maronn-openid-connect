/**
 * EXTENSION (dpop): the setting of OAuth 2.0 Demonstrating Proof of
 * Possession (RFC 9449), added to ProviderConfig (config.ts), and its default
 * (dpopConfigDefaults), to be laid over the defaults of config.ts.
 */
import type { ProviderConfig } from '../../config';
import { isSupportedDpopSigningAlg, SUPPORTED_DPOP_SIGNING_ALGS, type DpopSigningAlg } from './jwk';

declare module '../../config' {
  interface ProviderConfig {
    /**
     * EXTENSION (dpop): the JWS algorithms a DPoP proof may be signed with
     * (RFC 9449 §4.3), the values of dpop_signing_alg_values_supported (§5.1).
     * Asymmetric algorithms only (§11.6). An alg the checks of jwk.ts do not
     * verify (SUPPORTED_DPOP_SIGNING_ALGS) is left out by dpopSigningAlgsOf(),
     * even when listed here. By default every alg of
     * SUPPORTED_DPOP_SIGNING_ALGS; set ['ES256'] to accept ES256 only.
     */
    dpopSigningAlgValuesSupported: readonly string[];
  }
}

/** The default of the DPoP setting, to be laid over the defaults of config.ts. */
export const dpopConfigDefaults = {
  // RFC 9449 §5.1: every alg the checks of jwk.ts verify.
  dpopSigningAlgValuesSupported: [...SUPPORTED_DPOP_SIGNING_ALGS],
} satisfies Partial<ProviderConfig>;

/**
 * DPoP proof の署名に受け付ける alg を、設定の順に返す。
 *
 * 設定の `dpopSigningAlgValuesSupported` のうち、`jwk.ts` が署名を検証できる alg（`SUPPORTED_DPOP_SIGNING_ALGS`）だけを返す。
 * 検証できない alg（`none`、`HS256` のような MAC、この実装にない `ES256K` など）は、設定に挙げても返さない。
 * 返す値は、DPoP proof の `alg` の検査と、`dpop_signing_alg_values_supported` に使う値である。
 *
 * @spec RFC 9449 §4.3
 * @spec RFC 9449 §5.1
 * @spec RFC 9449 §11.6
 */
export function dpopSigningAlgsOf(config: Pick<ProviderConfig, 'dpopSigningAlgValuesSupported'>): readonly DpopSigningAlg[] {
  return config.dpopSigningAlgValuesSupported.filter(isSupportedDpopSigningAlg);
}
