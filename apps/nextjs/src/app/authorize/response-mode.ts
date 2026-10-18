/**
 * How an authorization response travels back to the client.
 *
 * The plain response mode puts the parameters in the query of the
 * redirect_uri, with iss (RFC 9207 §2). A feature that answers in another mode
 * (JARM's query.jwt) gives route.ts an AuthorizationResponseMode for the
 * request, and registers an AuthorizationResponseModeHandler in its feature.ts
 * so the consent step can answer in the same mode from the stored transaction.
 */
import type { AuthTransaction } from '@maronn-openid-connect/core';
import { responseModesOf } from '../_oidc-provider/feature';
import { features } from '../_oidc-provider/features';
import type { ProviderSigningKeys } from '../_oidc-provider/provider';

export type AuthorizationResponseParameters = Record<string, string | undefined>;

export interface AuthorizationResponseMode {
  /** The response_mode value. It is stored on the transaction so /consent answers in the same mode. */
  readonly name: string;
  /** The redirect URL that carries the parameters in this mode. */
  redirect(redirectUri: string, parameters: AuthorizationResponseParameters): Promise<string>;
}

export interface AuthorizationResponseModeHandler {
  /** The names (AuthorizationResponseMode.name) it restores. */
  readonly names: readonly string[];
  /**
   * The response mode of a stored transaction. The keys are loaded when a
   * handler asks for them, so the module of a handler does not import
   * provider.ts: features.ts reaches it, and provider.ts reads features.ts.
   */
  restore(input: {
    name: string;
    clientId: string;
    issuer: string;
    loadSigningKeys: () => Promise<ProviderSigningKeys>;
  }): Promise<AuthorizationResponseMode>;
}

/** A transaction with the response mode the authorization request asked for (the transaction store keeps fields it does not know). */
export type ResponseModeTransaction = AuthTransaction & { responseMode?: string };

/**
 * The response mode a stored transaction asked for, from the feature that
 * answers in it; undefined for the plain query response.
 */
export async function restoreResponseMode(
  transaction: ResponseModeTransaction,
  input: { issuer: string; loadSigningKeys: () => Promise<ProviderSigningKeys> },
): Promise<AuthorizationResponseMode | undefined> {
  const name = transaction.responseMode;
  if (name === undefined) return undefined;
  const handler = responseModesOf(features).find((candidate) => candidate.names.includes(name));
  if (handler === undefined) {
    throw new Error(`No enabled feature answers in the response mode "${name}"`);
  }
  return handler.restore({ name, clientId: transaction.clientId, ...input });
}

/**
 * The redirect URL of an authorization response: in the response mode when
 * there is one, otherwise the parameters in the query with iss (RFC 9207 §2).
 */
export async function authorizationResponseUrl(
  responseMode: AuthorizationResponseMode | undefined,
  redirectUri: string,
  parameters: AuthorizationResponseParameters,
  issuer: string,
): Promise<string> {
  if (responseMode) return responseMode.redirect(redirectUri, parameters);
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  url.searchParams.set('iss', issuer);
  return url.toString();
}
