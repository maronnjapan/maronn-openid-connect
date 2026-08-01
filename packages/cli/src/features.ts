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
 * Experimental features are a separate category: they are never part of the
 * default output and must be requested explicitly with `--enable`.
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
 * Experimental feature names (kebab-case, used with --enable).
 *
 * Unlike AVAILABLE_FEATURES these are **disabled by default** and are only
 * generated when named explicitly with `--enable`. They are implemented in the
 * separate `@maronn-oidc/experimental` package, whose API is unstable and may
 * change in a breaking way between releases.
 *
 * - par: Pushed Authorization Requests (RFC 9126).
 * - token-exchange: OAuth 2.0 Token Exchange (RFC 8693), impersonation only.
 */
export const EXPERIMENTAL_FEATURES = ['par', 'token-exchange'] as const;

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
 *   `request_uri` values through `@maronn-oidc/experimental/par`.
 * - tokenExchange: experimental, disabled by default. When true, the token
 *   route dispatches the `urn:ietf:params:oauth:grant-type:token-exchange`
 *   grant (RFC 8693) to `@maronn-oidc/experimental/token-exchange` before
 *   core's grant_type validation would reject the URN.
 */
export interface OidcFeatureConfig {
  pkce: boolean;
  refreshToken: boolean;
  introspection: boolean;
  revocation: boolean;
  requestObject: boolean;
  par: boolean;
  tokenExchange: boolean;
}

/** Mapping from CLI feature names to OidcFeatureConfig keys. */
const FEATURE_KEYS: Record<FeatureName, keyof OidcFeatureConfig> = {
  pkce: 'pkce',
  'refresh-token': 'refreshToken',
  introspection: 'introspection',
  revocation: 'revocation',
  'request-object': 'requestObject',
};

/** Mapping from CLI experimental feature names to OidcFeatureConfig keys. */
const EXPERIMENTAL_FEATURE_KEYS: Record<ExperimentalFeatureName, keyof OidcFeatureConfig> = {
  par: 'par',
  'token-exchange': 'tokenExchange',
};

/**
 * Default: every stable feature enabled (matches the historical generation
 * output), every experimental feature disabled.
 */
export const DEFAULT_FEATURES: OidcFeatureConfig = {
  pkce: true,
  refreshToken: true,
  introspection: true,
  revocation: true,
  requestObject: true,
  par: false,
  tokenExchange: false,
};

function isExperimentalFeature(name: string): name is ExperimentalFeatureName {
  return (EXPERIMENTAL_FEATURES as readonly string[]).includes(name);
}

function assertKnownFeature(name: string): asserts name is FeatureName | ExperimentalFeatureName {
  if (
    !(AVAILABLE_FEATURES as readonly string[]).includes(name) &&
    !isExperimentalFeature(name)
  ) {
    throw new Error(
      `Unknown feature: "${name}". Available features: ${AVAILABLE_FEATURES.join(', ')}. ` +
        `Experimental features (disabled by default): ${EXPERIMENTAL_FEATURES.join(', ')}`,
    );
  }
}

function featureKey(name: FeatureName | ExperimentalFeatureName): keyof OidcFeatureConfig {
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
  // An experimental feature listed in --disable is already off by default, so
  // this is a no-op rather than an error (same result as omitting it).
  for (const name of disable) {
    assertKnownFeature(name);
    features[featureKey(name)] = false;
  }
  return features;
}
