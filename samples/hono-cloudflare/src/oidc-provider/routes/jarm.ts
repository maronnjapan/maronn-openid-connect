/**
 * EXPERIMENTAL — JWT Secured Authorization Response Mode (JARM).
 *
 * This module was generated because the OP was created with `--enable jarm`.
 * It is backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * Imported by the authorize and consent routes, so keep all three in sync when
 * changing these settings.
 *
 * - jarmResponseLifetimeSeconds: how long the response JWT stays valid (its
 *   `exp` claim). JARM Section 2.1 RECOMMENDs a maximum lifetime of 10 minutes,
 *   so values outside 5-600 seconds fail fast at module load. Keep it short: the
 *   JWT rides in a URL and only needs to survive one browser redirect.
 *
 * Not configurable: the signing algorithm (RS256, JARM Section 3's default for a
 * client with no registered authorization_signed_response_alg), the response
 * parameter name (`response`, JARM Section 2.3.1) and the supported response
 * modes (`query.jwt` / `jwt` — this OP implements response_type=code only, so
 * `fragment.jwt` and `form_post.jwt` are rejected with invalid_request).
 */
import { assertJarmLifetimeSeconds } from '@maronn-openid-connect/experimental/jarm';

export const jarmConfig = {
  jarmResponseLifetimeSeconds: 60,
};

assertJarmLifetimeSeconds(jarmConfig.jarmResponseLifetimeSeconds);
