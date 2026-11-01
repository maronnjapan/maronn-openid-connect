/**
 * The setting of the request-object feature, added to ProviderConfig
 * (config.ts). Its default is in feature.ts.
 */
declare module '../../config.js' {
  interface ProviderConfig {
    /**
     * OIDC Core 1.0 §6.1: 署名無し（`alg: "none"`）Request Object を互換受理するか。
     * 既定は false（署名付き Request Object のみ受理）。OIDF Conformance Suite の一部
     * module は unsigned Request Object を送るため、Basic OP conformance 互換のときだけ
     * true にする。true の場合は discovery の request_object_signing_alg_values_supported に
     * "none" も広告される。
     */
    allowUnsignedRequestObject: boolean;
    /**
     * The JWS algs a signed Request Object may use (OIDC Discovery 1.0 §3
     * request_object_signing_alg_values_supported, RFC 9101 §4). Discovery
     * advertises them (with none when allowUnsignedRequestObject is on), and
     * dynamic client registration accepts them as request_object_signing_alg.
     * By default the algs core verifies: RS256, RS384, RS512 (RFC 7518 §3.3)
     * and ES256, ES384, ES512 (§3.4). Set ['RS256'] to accept RS256 only.
     */
    requestObjectSigningAlgValuesSupported: readonly string[];
  }
}

export {};
