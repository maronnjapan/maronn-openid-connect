import { shared } from '../../shared';

/**
 * The settings of the request-object feature. createProviderConfig() of
 * config.ts takes their defaults from feature.ts.
 */
declare module '../../config' {
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

/**
 * What the request-object feature needs beyond the provider settings:
 * the fetch a request_uri is retrieved with (OIDC Core 1.0 §6.2.3),
 * globalThis.fetch while requestUriFetch is undefined. Set it where the app
 * starts (instrumentation.ts) to add a trust store, a proxy or an allow-list
 * of your own, or to record what the OP retrieves in tests. Whatever it returns
 * is verified like a Request Object passed by value. Kept on globalThis
 * (shared()) so the Route Handlers see what instrumentation.ts set.
 */
export const requestObjectConfig = shared<{ requestUriFetch: typeof fetch | undefined }>(
  'requestObjectConfig',
  () => ({ requestUriFetch: undefined }),
);
