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
 * - token-exchange: OAuth 2.0 Token Exchange (RFC 8693), impersonation only.
 * - jarm: JWT Secured Authorization Response Mode (JARM), signed query.jwt only.
 */
export const EXPERIMENTAL_FEATURES = ['par', 'token-exchange', 'jarm'] as const;

export type ExperimentalFeatureName = (typeof EXPERIMENTAL_FEATURES)[number];

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
};

/**
 * Default: every stable feature enabled (matches the historical generation
 * output), every optional and experimental feature disabled.
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
  transactionBinding: false,
};

function isOptionalFeature(name: string): name is OptionalFeatureName {
  return (OPTIONAL_FEATURES as readonly string[]).includes(name);
}

function isExperimentalFeature(name: string): name is ExperimentalFeatureName {
  return (EXPERIMENTAL_FEATURES as readonly string[]).includes(name);
}

function assertKnownFeature(
  name: string,
): asserts name is FeatureName | OptionalFeatureName | ExperimentalFeatureName {
  if (
    !(AVAILABLE_FEATURES as readonly string[]).includes(name) &&
    !isOptionalFeature(name) &&
    !isExperimentalFeature(name)
  ) {
    throw new Error(
      `Unknown feature: "${name}". Available features: ${AVAILABLE_FEATURES.join(', ')}. ` +
        `Optional features (disabled by default): ${OPTIONAL_FEATURES.join(', ')}. ` +
        `Experimental features (disabled by default): ${EXPERIMENTAL_FEATURES.join(', ')}`,
    );
  }
}

function featureKey(
  name: FeatureName | OptionalFeatureName | ExperimentalFeatureName,
): keyof OidcFeatureConfig {
  if (isOptionalFeature(name)) return OPTIONAL_FEATURE_KEYS[name];
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
  // An optional / experimental feature listed in --disable is already off by
  // default, so this is a no-op rather than an error (same as omitting it).
  for (const name of disable) {
    assertKnownFeature(name);
    features[featureKey(name)] = false;
  }
  return features;
}
