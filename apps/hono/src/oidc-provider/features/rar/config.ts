/**
 * EXPERIMENTAL — Rich Authorization Requests settings (RFC 9396).
 *
 * Read by the validate-authorization-details step of the authorization
 * endpoint. The type definitions themselves (`rarTypes`) live on
 * ProviderConfig, so an application injects them next to its other provider
 * settings.
 *
 * - maxAuthorizationDetailsBytes: UTF-8 byte cap of the whole parameter
 *   (range 1024–65536). RFC 9396 §11.4 points large requests to PAR; this cap
 *   is the DoS guard for everything the endpoint still parses.
 * - maxAuthorizationDetailsEntries: entries allowed in the array (range 1–64).
 */
import type { AuthorizationDetailTypeDefinition } from '@maronn-openid-connect/experimental/rar';

export const rarConfig = {
  maxAuthorizationDetailsBytes: 16384,
  maxAuthorizationDetailsEntries: 16,
};

// Fail fast on a config edit that leaves the documented ranges: a typo here
// either re-opens the DoS surface or rejects every request.
if (rarConfig.maxAuthorizationDetailsBytes < 1024 || rarConfig.maxAuthorizationDetailsBytes > 65536) {
  throw new Error('rarConfig.maxAuthorizationDetailsBytes must be between 1024 and 65536');
}
if (rarConfig.maxAuthorizationDetailsEntries < 1 || rarConfig.maxAuthorizationDetailsEntries > 64) {
  throw new Error('rarConfig.maxAuthorizationDetailsEntries must be between 1 and 64');
}

declare module '../../config.js' {
  interface ProviderConfig {
    /**
     * EXPERIMENTAL (RFC 9396 §5): 受理する authorization details 型の定義。
     * 登録した type だけが受理され、空（未設定）なら `authorization_details`
     * 付きのリクエストはすべて `invalid_authorization_details` になる
     * （fail-closed）。discovery はこの一覧の type 値を
     * `authorization_details_types_supported` として広告する（§10）。
     */
    rarTypes?: readonly AuthorizationDetailTypeDefinition[];
  }
}
