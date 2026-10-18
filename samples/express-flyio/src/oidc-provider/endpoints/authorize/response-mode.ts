/**
 * How an authorization response travels back to the client.
 *
 * Every provider answers in the plain query response mode (RFC 6749 §4.1.2):
 * code, state and iss as query parameters of the redirect URI. A feature can
 * answer in a response mode of its own — JARM signs the parameters into one
 * JWT — by producing an AuthorizationResponseMode in the authorization
 * pipeline, and restoring it at /consent through the authorize.responseModes
 * entry of its feature.ts.
 */
import type { AuthTransaction } from '@maronn-openid-connect/core';
import { features } from '../../features/enabled.js';
import { responseModesOf } from '../../features/feature.js';

/** The parameters of an authorization response (RFC 6749 §4.1.2 / §4.1.2.1). */
export type AuthorizationResponseParameters = Record<string, string | undefined>;

/** A response mode other than the plain query (undefined). */
export interface AuthorizationResponseMode {
  /** The response_mode value. It is stored on the transaction so /consent answers in the same mode. */
  readonly name: string;
  /** The redirect URL that carries the parameters in this mode. */
  redirect(redirectUri: string, parameters: AuthorizationResponseParameters): Promise<string>;
}

/** A response mode of a feature, as /consent restores it from the stored transaction. */
export interface AuthorizationResponseModeHandler {
  /** The names (AuthorizationResponseMode.name) it restores. */
  readonly names: readonly string[];
  restore(c: any, input: { name: string; clientId: string; issuer: string }): AuthorizationResponseMode;
}

/** The transaction as stored: the name of its response mode, when it is not the plain query. */
export type ResponseModeTransaction = AuthTransaction & { responseMode?: string };

/**
 * The response mode a stored transaction asked for, restored by the feature
 * that answers in it; undefined for the plain query response.
 *
 * @throws {Error} when the transaction names a response mode no enabled
 *   feature answers in (a configuration change while the transaction was
 *   open), which the endpoints answer with server_error.
 */
export function restoreResponseMode(
  c: any,
  transaction: ResponseModeTransaction,
): AuthorizationResponseMode | undefined {
  const name = transaction.responseMode;
  if (name === undefined) return undefined;
  const handler = responseModesOf(features).find((candidate) => candidate.names.includes(name));
  if (handler === undefined) {
    throw new Error(`No enabled feature answers in the response mode "${name}"`);
  }
  return handler.restore(c, { name, clientId: transaction.clientId, issuer: c.get('config').issuer });
}
