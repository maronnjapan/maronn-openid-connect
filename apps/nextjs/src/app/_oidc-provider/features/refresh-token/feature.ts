import { defineFeature } from '../../feature';

/**
 * The refresh_token grant (OAuth 2.1 §4.3), offline_access (OIDC Core 1.0 §11)
 * and refresh token rotation. The token endpoint calls it in its
 * (feature: refresh-token) blocks.
 */
export const refreshToken = defineFeature({
  id: 'refresh-token',
  token: { grants: ['refresh_token'] },
  // OIDC Core 1.0 §11: offline_access is advertised so relying parties (and the
  // OIDF Conformance Suite's oidcc-refresh-token module) know they may request
  // refresh tokens via 'scope=openid offline_access' with prompt=consent.
  // It is a refresh-token request scope, not a claim scope, so no matching
  // entry is added to claims_supported.
  discovery: () => ({ scopes_supported: ['offline_access'] }),
});
