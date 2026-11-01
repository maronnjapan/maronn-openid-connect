/**
 * The settings of the request-object feature, added to ProviderConfig
 * (config.ts) and to the options of createApp() / applyOidc() (app.ts).
 * Their defaults are in feature.ts.
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
     * OIDC Core 1.0 §6.2 / OIDC Discovery 1.0 §3 `require_request_uri_registration`:
     * 認可リクエストの `request_uri` を、クライアントが登録した `request_uris`
     * （OIDC Dynamic Client Registration 1.0 §2。静的クライアントは RegisteredClient の
     * requestUris）と完全一致するものに限るか。既定は true で、OP が取得しに行く URL を
     * 登録済みのものに閉じる。false にすると、構文を満たす https の URL（ループバックの
     * http を含む）ならどれでも取得しに行くので、OP から到達できる内部サービスを
     * 探られる面（SSRF）が開く。信頼できる環境以外では true のままにする。
     */
    requireRequestUriRegistration: boolean;
  }
}

declare module '../../app.js' {
  interface OidcProviderOptions {
    /**
     * OIDC Core 1.0 §6.2.3: the fetch the OP retrieves a request_uri with.
     * Defaults to globalThis.fetch. Pass one to add a trust store, a proxy or
     * an allow-list of your own, or to record what the OP retrieves in tests.
     * Whatever it returns is verified like a Request Object passed by value.
     */
    requestUriFetch?: typeof fetch;
  }
}

export {};
