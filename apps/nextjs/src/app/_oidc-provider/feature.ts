/**
 * What a feature can add to the provider.
 *
 * Each directory under _oidc-provider/features/ is one feature, and its
 * feature.ts describes it with defineFeature(): the discovery metadata it
 * advertises, the defaults it adds to the provider settings, the values of
 * provider.ts it replaces, the grants it answers at the token endpoint, the
 * response types it answers at /authorize besides code, the response modes it
 * restores at /consent and the login methods it shows on the login page.
 * These are the hooks; the rest of the provider reads them through the
 * functions below and never imports a feature.
 *
 * The endpoints of a feature are Route Handlers in its route group,
 * app/(<feature-id>)/, which URLs do not see. Logic that runs inside a Route
 * Handler of the provider is not a hook: that route.ts calls the feature in a
 * block whose marker line names it, `// [step-id] (feature: <id>) Label — Spec`.
 *
 * _oidc-provider/features.ts lists the features of this provider. Remove a
 * feature by deleting its directory, its route group, its lines there, the
 * owner blocks that name it in the route.ts files and the lines of its steps
 * in the endpoint.ts beside them.
 */
import type {
  AuthorizationResponseType,
  ClientKeyResolver,
  ClientResolver,
  TokenClientResolver,
} from '@maronn-openid-connect/core';
import type { AuthorizationResponseModeHandler } from '../authorize/response-mode';
import type { LoginMethod } from '../login/login-method';
import type { ProviderConfig } from './config';

/** The values provider.ts builds once that a feature may replace (the context hook). */
export interface ProviderContext {
  clientResolver: ClientResolver & TokenClientResolver;
  /** The public keys of the clients by purpose (core's ClientKeyResolver). */
  clientKeyResolver: ClientKeyResolver;
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
    /**
     * The response_type values the feature answers besides code (OIDC Core
     * 1.0 §3), as core's normalizeResponseType() writes them: the
     * authorization endpoint accepts them and discovery advertises them
     * (response_types_supported). The feature answers them in its blocks of
     * authorize/route.ts and consent/decision/route.ts.
     */
    readonly responseTypes?: readonly AuthorizationResponseType[];
  };
  /** Ways to sign in that the login page offers next to the password form. */
  readonly loginMethods?: readonly LoginMethod[];
}

/**
 * 機能の説明を受け取り、そのまま返す。
 *
 * 実行時には何もしない。
 * 引数が `Feature` の形であることは、TypeScript の型検査で確かめる。
 */
export function defineFeature<const F extends Feature>(feature: F): F {
  return feature;
}

/**
 * OP のメタデータに、機能が加える項目を足して返す。
 *
 * 機能の順に各機能の `discovery` を `issuer` と `config` で呼び、返った項目を重ねる。
 * 元の値と新しい値がどちらも配列なら、順序を保ったまま重複を除いてつなげ、それ以外は新しい値で置き換える。
 * 受け取った `metadata` は書き換えず、新しいオブジェクトを返す。
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

/**
 * 機能が加える設定の既定値を一つにまとめて返す。
 *
 * 機能の順に重ね、同じ項目は後の機能の値を使う。
 */
export function configOf(features: readonly Feature[]): Partial<ProviderConfig> {
  return Object.assign({}, ...features.map((feature) => feature.config ?? {}));
}

/**
 * 機能のフックで置き換えた `provider.ts` の値を返す。
 *
 * 一覧の順に各機能の `context` を、それまでに置き換えた値を渡して呼び、返った値で上書きする。
 * `context` のない機能は何も変えない。
 */
export function contextOf(features: readonly Feature[], provider: ProviderContext): ProviderContext {
  return features.reduce<ProviderContext>(
    (current, feature) => ({ ...current, ...feature.context?.(current) }),
    provider,
  );
}

/**
 * 機能が受け付ける `grant_type` の値を重複なく返す。
 *
 * トークンエンドポイントで受け付けるグラントタイプを、機能の順に集める。
 */
export function tokenGrantsOf(features: readonly Feature[]): string[] {
  return [...new Set(features.flatMap((feature) => feature.token?.grants ?? []))];
}

/**
 * 機能が加えるレスポンスモードのハンドラを返す。
 *
 * 認可エンドポイントで機能が応答に使うレスポンスモードを、機能の順に並べる。
 */
export function responseModesOf(features: readonly Feature[]): AuthorizationResponseModeHandler[] {
  return features.flatMap((feature) => feature.authorize?.responseModes ?? []);
}

/**
 * `code` 以外の `response_type` の値を重複なく返す。
 *
 * 機能が受け付ける値を、機能の順に集める。
 */
export function responseTypesOf(features: readonly Feature[]): AuthorizationResponseType[] {
  return [...new Set(features.flatMap((feature) => feature.authorize?.responseTypes ?? []))];
}

/**
 * 機能が加えるログイン方法を返す。
 *
 * ログイン画面で、パスワードのフォームのほかに示すログイン方法を、機能の順に並べる。
 */
export function loginMethodsOf(features: readonly Feature[]): LoginMethod[] {
  return features.flatMap((feature) => feature.loginMethods ?? []);
}
