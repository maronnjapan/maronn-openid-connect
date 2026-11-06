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
    /**
     * OIDC Core 1.0 §6.2: fetch the Request Object a client passes by
     * reference (request_uri) and verify it as one passed by value. Discovery
     * advertises request_uri_parameter_supported with this value. Default
     * true. With false, a request_uri that is a URL is rejected with
     * request_uri_not_supported (a PAR request_uri is expanded before).
     */
    requestUriParameterSupported: boolean;
    /**
     * OIDC Discovery 1.0 §3 require_request_uri_registration: fetch only a
     * request_uri the client registered in request_uris (OIDC Dynamic Client
     * Registration 1.0 §2), compared exactly; any other is
     * invalid_request_uri. Default false.
     */
    requireRequestUriRegistration: boolean;
    /**
     * Let a request_uri use http, localhost, and loopback, private and
     * link-local addresses. For development only: by default the OP fetches
     * https URLs of public hosts only (RFC 9101 §10.4.1). Dynamic client
     * registration accepts http request_uris with it too.
     */
    allowInsecureRequestUri: boolean;
    /** How long (milliseconds) the OP waits for a request_uri to answer (RFC 9101 §10.4.2). Default 3000. */
    requestUriTimeoutMs: number;
    /** The largest Request Object (bytes) the OP reads from a request_uri. Default 65536. */
    requestUriMaxBytes: number;
    /** The longest request_uri (characters) the OP accepts (RFC 9101 §5.2: 512 ASCII characters). Default 512. */
    requestUriMaxLength: number;
  }
}

export {};
