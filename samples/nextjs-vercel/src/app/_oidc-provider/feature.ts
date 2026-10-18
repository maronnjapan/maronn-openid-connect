/**
 * What a feature can add to the provider.
 *
 * Each directory under _oidc-provider/features/ is one feature, and its
 * feature.ts describes it with defineFeature(): the discovery metadata it
 * advertises, the defaults it adds to the provider settings, the values of
 * provider.ts it replaces, the grants it answers at the token endpoint, the
 * response modes it restores at /consent and the login methods it shows on
 * the login page. These are the hooks; the rest of the provider reads them
 * through the functions below and never imports a feature.
 *
 * The endpoints of a feature are Route Handlers in its route group,
 * app/(<feature-id>)/, which URLs do not see. Logic that runs inside a Route
 * Handler of the provider is not a hook: that route.ts calls the feature in a
 * block whose marker line names it, `// [step-id] (feature: <id>) Label — Spec`.
 *
 * _oidc-provider/features.ts lists the features of this provider. Remove a
 * feature by deleting its directory, its route group and its line there.
 */
import type { ClientResolver, TokenClientResolver } from '@maronn-openid-connect/core';
import type { AuthorizationResponseModeHandler } from '../authorize/response-mode';
import type { LoginMethod } from '../login/login-method';
import type { ProviderConfig } from './config';

/** The values provider.ts builds once that a feature may replace (the context hook). */
export interface ProviderContext {
  clientResolver: ClientResolver & TokenClientResolver;
}

export interface Feature {
  /** The id of --enable / --disable. */
  readonly id: string;
  /**
   * Members added to the provider metadata (OIDC Discovery 1.0 §3). An array
   * is merged with the array the provider already advertises under that name;
   * any other value replaces it.
   */
  readonly discovery?: (issuer: string, config: ProviderConfig) => Record<string, unknown>;
  /** Defaults of the provider settings, applied over the defaults of config.ts. */
  readonly config?: Partial<ProviderConfig>;
  /** Replaces values of provider.ts, given the ones built so far. */
  readonly context?: (provider: ProviderContext) => Partial<ProviderContext>;
  readonly token?: {
    /**
     * The grant_type values the feature answers at the token endpoint. The
     * token endpoint accepts them and discovery advertises them
     * (grant_types_supported).
     */
    readonly grants?: readonly string[];
  };
  readonly authorize?: {
    /**
     * Response modes the feature answers in. /consent restores the one the
     * authorization request asked for from the stored transaction.
     */
    readonly responseModes?: readonly AuthorizationResponseModeHandler[];
  };
  /** Ways to sign in that the login page offers next to the password form. */
  readonly loginMethods?: readonly LoginMethod[];
}

/** Describe a feature. The function only checks the shape; it returns its argument. */
export function defineFeature<const F extends Feature>(feature: F): F {
  return feature;
}

/**
 * The provider metadata with the members of the features added: an array
 * member is merged (each value once, in order), any other member replaced.
 */
export function discoveryOf(
  features: readonly Feature[],
  metadata: Record<string, unknown>,
  issuer: string,
  config: ProviderConfig,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...metadata };
  for (const feature of features) {
    for (const [name, value] of Object.entries(feature.discovery?.(issuer, config) ?? {})) {
      const current = merged[name];
      merged[name] = Array.isArray(current) && Array.isArray(value)
        ? [...new Set([...current, ...value])]
        : value;
    }
  }
  return merged;
}

/** The setting defaults of the features, later ones over earlier ones. */
export function configOf(features: readonly Feature[]): Partial<ProviderConfig> {
  return Object.assign({}, ...features.map((feature) => feature.config ?? {}));
}

/** The values of provider.ts after every feature's context hook, in the order of the list. */
export function contextOf(features: readonly Feature[], provider: ProviderContext): ProviderContext {
  return features.reduce<ProviderContext>(
    (current, feature) => ({ ...current, ...feature.context?.(current) }),
    provider,
  );
}

/** The grant_type values the features answer at the token endpoint, each once. */
export function tokenGrantsOf(features: readonly Feature[]): string[] {
  return [...new Set(features.flatMap((feature) => feature.token?.grants ?? []))];
}

export function responseModesOf(features: readonly Feature[]): AuthorizationResponseModeHandler[] {
  return features.flatMap((feature) => feature.authorize?.responseModes ?? []);
}

export function loginMethodsOf(features: readonly Feature[]): LoginMethod[] {
  return features.flatMap((feature) => feature.loginMethods ?? []);
}
