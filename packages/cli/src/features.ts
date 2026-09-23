/**
 * Feature toggles for the generated OpenID Connect Provider.
 *
 * The default generation output enables every feature (the full Basic OP +
 * optional endpoints). Users can remove features from the default with
 * `--disable`, and explicitly (re-)enable them with `--enable`.
 *
 * Basic OP mandatory capabilities (authorize / token / userinfo / discovery /
 * jwks / login / consent) are not toggleable and are always generated.
 *
 * Optional features are stable core capabilities that are nonetheless NOT part
 * of the default output, because the spec does not require them. Experimental
 * features are a third category: they live in the separate experimental package
 * and their APIs are unstable. Both must be requested explicitly with
 * `--enable`.
 */

/** CLI-facing feature names (kebab-case, used with --enable / --disable). */
export const AVAILABLE_FEATURES = [
  'pkce',
  'refresh-token',
  'introspection',
  'revocation',
  'request-object',
] as const;

export type FeatureName = (typeof AVAILABLE_FEATURES)[number];

/**
 * Optional feature names (kebab-case, used with --enable).
 *
 * Stable, implemented in `@maronn-openid-connect/core` — but **disabled by
 * default** because no OIDC Core / OAuth 2.1 clause requires them. The default
 * generation output is meant to be the specification and nothing more, so a
 * user verifying "does the spec allow X?" is never answered by this library's
 * own hardening opinions. Turn one on to study the hardening itself.
 *
 * - transaction-binding: bind the authorization transaction to the User-Agent
 *   that started it, via a per-transaction HttpOnly cookie
 *   (OIDC Core 1.0 §3.1.2.3 / §3.1.2.4 leave the mechanism to the
 *   implementation). Costs a cookie jar: driving login / consent by hand with
 *   curl requires carrying the cookie, which is why it is not the default.
 */
export const OPTIONAL_FEATURES = ['transaction-binding'] as const;

export type OptionalFeatureName = (typeof OPTIONAL_FEATURES)[number];

/**
 * Experimental feature names (kebab-case, used with --enable).
 *
 * Unlike AVAILABLE_FEATURES these are **disabled by default** and are only
 * generated when named explicitly with `--enable`. They are implemented in the
 * separate `@maronn-openid-connect/experimental` package, whose API is unstable and may
 * change in a breaking way between releases.
 *
 * - par: Pushed Authorization Requests (RFC 9126).
 * - token-exchange: OAuth 2.0 Token Exchange (RFC 8693), impersonation and
 *   delegation (act claim per §4.1).
 * - jarm: JWT Secured Authorization Response Mode (JARM), signed query.jwt only.
 * - device-authorization-grant: OAuth 2.0 Device Authorization Grant (RFC 8628).
 * - id-jag: Identity Assertion Authorization Grant / Cross-App Access
 *   (draft-ietf-oauth-identity-assertion-authz-grant-04) — issuing ID-JAGs via
 *   token exchange and redeeming them on the jwt-bearer grant.
 * - ciba: OpenID Connect Client-Initiated Backchannel Authentication (CIBA)
 *   Core 1.0, poll mode only — the client presents a login_hint over the back
 *   channel and polls the token endpoint while the user approves on their own
 *   browser.
 * - jwt-introspection-response: JWT Response for OAuth Token Introspection
 *   (RFC 9701) — the introspection endpoint answers a request whose Accept
 *   header names application/token-introspection+jwt with a signed JWT.
 *   Requires the introspection feature (its endpoint carries the response).
 * - rp-initiated-logout: OpenID Connect RP-Initiated Logout 1.0 — the OP serves
 *   the end_session_endpoint (GET|POST /logout) with a confirmation screen for
 *   requests without a valid id_token_hint, and redirects to a registered
 *   post_logout_redirect_uri on an exact match only.
 */
export const EXPERIMENTAL_FEATURES = [
  'par',
  'token-exchange',
  'jarm',
  'device-authorization-grant',
  'id-jag',
  'ciba',
  'jwt-introspection-response',
  'rp-initiated-logout',
] as const;

export type ExperimentalFeatureName = (typeof EXPERIMENTAL_FEATURES)[number];

/**
 * Extension feature names (kebab-case, used with --enable).
 *
 * Extensions live in their own package because they pull in something core
 * deliberately does not: an upstream identity provider and its official client
 * library. Like the experimental features they are **disabled by default** and
 * only generated when named explicitly with `--enable`.
 *
 * - google-login: Sign in with Google (Google Identity Services, redirect mode)
 *   as a login method next to the username / password form. The generated
 *   login page renders the Google button and a new login_uri route
 *   (POST /login/google) verifies the posted ID token with Google's official
 *   google-auth-library through `@maronn-openid-connect/google-login`, then
 *   continues into the same session / consent steps as the password login.
 *   Node.js 22+ only: the Google library does not run on edge runtimes.
 */
export const EXTENSION_FEATURES = ['google-login'] as const;

export type ExtensionFeatureName = (typeof EXTENSION_FEATURES)[number];

/**
 * Resolved feature configuration passed through the generator pipeline.
 *
 * - pkce: when false, the generated config defaults to
 *   `allowNonPkceAuthorizationCodeFlow: true` (PKCE optional for explicit
 *   confidential clients; public clients still require it).
 * - refreshToken: when false, the token endpoint rejects the refresh_token
 *   grant with `unsupported_grant_type`, offline_access is never granted, and
 *   no refresh token is issued or persisted.
 * - introspection: when false, the RFC 7662 endpoint is not generated.
 * - revocation: when false, the RFC 7009 endpoint is not generated.
 * - requestObject: when false, the authorize endpoint rejects the `request`
 *   parameter with `request_not_supported` (OIDC Core 1.0 §6.3).
 * - par: experimental, disabled by default. When true, the PAR endpoint
 *   (RFC 9126) is generated and the authorize route resolves URN-form
 *   `request_uri` values through `@maronn-openid-connect/experimental/par`.
 * - tokenExchange: experimental, disabled by default. When true, the token
 *   route dispatches the `urn:ietf:params:oauth:grant-type:token-exchange`
 *   grant (RFC 8693) to `@maronn-openid-connect/experimental/token-exchange` before
 *   core's grant_type validation would reject the URN.
 * - jarm: experimental, disabled by default. When true, the authorize route
 *   interprets `response_mode=query.jwt` (and its `jwt` shorthand) and returns
 *   the authorization response as a single signed JWT in the `response` query
 *   parameter, via `@maronn-openid-connect/experimental/jarm`. A request that
 *   does not ask for a JWT response mode is answered exactly as before.
 * - deviceAuthorizationGrant: experimental, disabled by default. When true, the
 *   OP additionally serves the device authorization endpoint
 *   (POST /device_authorization), the verification UI (/device, /device/login,
 *   /device/approve) and dispatches the
 *   `urn:ietf:params:oauth:grant-type:device_code` grant (RFC 8628) to
 *   `@maronn-openid-connect/experimental/device-authorization-grant` before
 *   core's grant_type validation would reject the URN.
 * - idJag: experimental, disabled by default. When true, the token route issues
 *   ID-JAGs (Cross-App Access, draft-ietf-oauth-identity-assertion-authz-grant)
 *   on the token-exchange grant for
 *   `requested_token_type=urn:ietf:params:oauth:token-type:id-jag`, and redeems
 *   ID-JAGs from trusted identity providers on the
 *   `urn:ietf:params:oauth:grant-type:jwt-bearer` grant, both via
 *   `@maronn-openid-connect/experimental/id-jag` and both dispatched before
 *   core's grant_type validation would reject the URNs.
 * - ciba: experimental, disabled by default. When true, the OP additionally
 *   serves the backchannel authentication endpoint
 *   (POST /backchannel_authentication), the authentication device UI (/ciba,
 *   /ciba/login, /ciba/approve) and dispatches the
 *   `urn:openid:params:grant-type:ciba` grant (CIBA Core 1.0, poll mode) to
 *   `@maronn-openid-connect/experimental/ciba` before core's grant_type
 *   validation would reject the URN.
 * - jwtIntrospectionResponse: experimental, disabled by default. When true, the
 *   introspection route answers a request whose Accept header names
 *   application/token-introspection+jwt with a signed introspection JWT
 *   (RFC 9701 §5, typ token-introspection+jwt, RS256) via
 *   `@maronn-openid-connect/experimental/jwt-introspection-response`, after
 *   restricting the disclosed members to the authenticated caller (§3). A
 *   request that does not name that media type is answered exactly as before.
 * - rpInitiatedLogout: experimental, disabled by default. When true, the OP
 *   additionally serves the end_session_endpoint (GET|POST /logout) and the
 *   confirmation approve route (POST /logout/approve), advertises
 *   end_session_endpoint in discovery, and resolves the logout decision and the
 *   post_logout_redirect_uri (exact match against
 *   rpInitiatedLogoutConfig.postLogoutRedirectUris) via
 *   `@maronn-openid-connect/experimental/rp-initiated-logout`. Every other
 *   endpoint is generated exactly as before.
 * - googleLogin: extension, disabled by default. When true, the login page
 *   renders a "Sign in with Google" button (redirect mode) and the OP serves
 *   POST /login/google, which verifies the ID token Google posts there with
 *   google-auth-library via `@maronn-openid-connect/google-login`, binds it to
 *   the authorization transaction through a single-use nonce, provisions the
 *   user just-in-time (subject `google:<sub>`) and hands off to consent like the
 *   password login. The button appears only once config.googleLogin is set.
 * - transactionBinding: optional hardening, disabled by default. When true, the
 *   authorize endpoint issues a per-transaction HttpOnly cookie and the
 *   login / consent steps refuse to run for a User-Agent that cannot present
 *   it, so a leaked `transaction_id` alone drives no step of the flow.
 */
export interface OidcFeatureConfig {
  pkce: boolean;
  refreshToken: boolean;
  introspection: boolean;
  revocation: boolean;
  requestObject: boolean;
  par: boolean;
  tokenExchange: boolean;
  jarm: boolean;
  deviceAuthorizationGrant: boolean;
  idJag: boolean;
  ciba: boolean;
  jwtIntrospectionResponse: boolean;
  rpInitiatedLogout: boolean;
  googleLogin: boolean;
  transactionBinding: boolean;
}

/** Mapping from CLI feature names to OidcFeatureConfig keys. */
const FEATURE_KEYS: Record<FeatureName, keyof OidcFeatureConfig> = {
  pkce: 'pkce',
  'refresh-token': 'refreshToken',
  introspection: 'introspection',
  revocation: 'revocation',
  'request-object': 'requestObject',
};

/** Mapping from CLI optional feature names to OidcFeatureConfig keys. */
const OPTIONAL_FEATURE_KEYS: Record<OptionalFeatureName, keyof OidcFeatureConfig> = {
  'transaction-binding': 'transactionBinding',
};

/** Mapping from CLI experimental feature names to OidcFeatureConfig keys. */
const EXPERIMENTAL_FEATURE_KEYS: Record<ExperimentalFeatureName, keyof OidcFeatureConfig> = {
  par: 'par',
  'token-exchange': 'tokenExchange',
  jarm: 'jarm',
  'device-authorization-grant': 'deviceAuthorizationGrant',
  'id-jag': 'idJag',
  ciba: 'ciba',
  'jwt-introspection-response': 'jwtIntrospectionResponse',
  'rp-initiated-logout': 'rpInitiatedLogout',
};

/** Mapping from CLI extension feature names to OidcFeatureConfig keys. */
const EXTENSION_FEATURE_KEYS: Record<ExtensionFeatureName, keyof OidcFeatureConfig> = {
  'google-login': 'googleLogin',
};

/**
 * Default: every stable feature enabled (matches the historical generation
 * output), every optional, experimental and extension feature disabled.
 */
export const DEFAULT_FEATURES: OidcFeatureConfig = {
  pkce: true,
  refreshToken: true,
  introspection: true,
  revocation: true,
  requestObject: true,
  par: false,
  tokenExchange: false,
  jarm: false,
  deviceAuthorizationGrant: false,
  idJag: false,
  ciba: false,
  jwtIntrospectionResponse: false,
  rpInitiatedLogout: false,
  googleLogin: false,
  transactionBinding: false,
};

function isOptionalFeature(name: string): name is OptionalFeatureName {
  return (OPTIONAL_FEATURES as readonly string[]).includes(name);
}

function isExperimentalFeature(name: string): name is ExperimentalFeatureName {
  return (EXPERIMENTAL_FEATURES as readonly string[]).includes(name);
}

function isExtensionFeature(name: string): name is ExtensionFeatureName {
  return (EXTENSION_FEATURES as readonly string[]).includes(name);
}

function assertKnownFeature(
  name: string,
): asserts name is FeatureName | OptionalFeatureName | ExperimentalFeatureName | ExtensionFeatureName {
  if (
    !(AVAILABLE_FEATURES as readonly string[]).includes(name) &&
    !isOptionalFeature(name) &&
    !isExperimentalFeature(name) &&
    !isExtensionFeature(name)
  ) {
    throw new Error(
      `Unknown feature: "${name}". Available features: ${AVAILABLE_FEATURES.join(', ')}. ` +
        `Optional features (disabled by default): ${OPTIONAL_FEATURES.join(', ')}. ` +
        `Experimental features (disabled by default): ${EXPERIMENTAL_FEATURES.join(', ')}. ` +
        `Extension features (disabled by default): ${EXTENSION_FEATURES.join(', ')}`,
    );
  }
}

function featureKey(
  name: FeatureName | OptionalFeatureName | ExperimentalFeatureName | ExtensionFeatureName,
): keyof OidcFeatureConfig {
  if (isOptionalFeature(name)) return OPTIONAL_FEATURE_KEYS[name];
  if (isExtensionFeature(name)) return EXTENSION_FEATURE_KEYS[name];
  return isExperimentalFeature(name) ? EXPERIMENTAL_FEATURE_KEYS[name] : FEATURE_KEYS[name];
}

/**
 * Resolve CLI --enable / --disable lists into an OidcFeatureConfig,
 * starting from DEFAULT_FEATURES.
 *
 * @throws {Error} on an unknown feature name, or a feature listed in both
 *   enable and disable.
 */
export function resolveFeatures(options: {
  enable?: string[];
  disable?: string[];
}): OidcFeatureConfig {
  const enable = options.enable ?? [];
  const disable = options.disable ?? [];

  for (const name of [...enable, ...disable]) {
    assertKnownFeature(name);
  }

  for (const name of enable) {
    if (disable.includes(name)) {
      throw new Error(`Feature "${name}" cannot be both enabled and disabled`);
    }
  }

  const features: OidcFeatureConfig = { ...DEFAULT_FEATURES };
  for (const name of enable) {
    assertKnownFeature(name);
    features[featureKey(name)] = true;
  }
  // An optional / experimental / extension feature listed in --disable is
  // already off by default, so this is a no-op rather than an error (same as
  // omitting it).
  for (const name of disable) {
    assertKnownFeature(name);
    features[featureKey(name)] = false;
  }
  // Cross-feature dependency: the RFC 9701 JWT response rides on the RFC 7662
  // introspection endpoint, which is not generated when introspection is
  // disabled — there would be nowhere to answer with the JWT.
  if (features.jwtIntrospectionResponse && !features.introspection) {
    throw new Error(
      'Feature "jwt-introspection-response" requires the introspection feature: ' +
        'the RFC 9701 JWT response is returned by the RFC 7662 introspection endpoint, ' +
        'which is not generated when introspection is disabled',
    );
  }
  return features;
}
