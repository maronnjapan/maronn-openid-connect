/**
 * How an authorization response travels back to the client.
 *
 * The plain response mode puts the parameters in the query of the
 * redirect_uri, with iss (RFC 9207 §2). A feature that answers in another mode
 * (JARM's query.jwt, the Form Post Response Mode) gives route.ts an
 * AuthorizationResponseMode for the request, and registers an
 * AuthorizationResponseModeHandler in its feature.ts so the consent step can
 * answer in the same mode from the stored transaction.
 *
 * A response mode decides what the parameters look like and how the browser
 * carries them: in the URL it is redirected to, or in the body of a form it
 * posts. respondToClient() turns either into the HTTP response.
 */
import { NextResponse } from 'next/server';
import type { AuthTransaction } from '@maronn-openid-connect/core';
import { responseModesOf } from '../_oidc-provider/feature';
import { features } from '../_oidc-provider/features';
import { formPostPage } from '../_oidc-provider/html';
import type { ProviderSigningKeys } from '../_oidc-provider/provider';

export type AuthorizationResponseParameters = Record<string, string | undefined>;

/** An authorization response, as the browser carries it to the client. */
export type AuthorizationResponse =
  /** The browser is redirected to location, which carries the parameters. */
  | { method: 'redirect'; location: string }
  /**
   * OAuth 2.0 Form Post Response Mode §2: the OP answers with an HTML form
   * whose action is the redirect URI and whose method is POST, and the
   * browser submits it with the parameters as its fields.
   */
  | { method: 'form_post'; action: string; fields: Record<string, string> };

export interface AuthorizationResponseMode {
  /** The response_mode value. It is stored on the transaction so /consent answers in the same mode. */
  readonly name: string;
  /** The authorization response that carries the parameters in this mode. */
  respond(redirectUri: string, parameters: AuthorizationResponseParameters): Promise<AuthorizationResponse>;
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
 * The authorization response: in the response mode when there is one,
 * otherwise the parameters in the query with iss (RFC 9207 §2).
 */
export async function authorizationResponseOf(
  responseMode: AuthorizationResponseMode | undefined,
  redirectUri: string,
  parameters: AuthorizationResponseParameters,
  issuer: string,
): Promise<AuthorizationResponse> {
  if (responseMode) return responseMode.respond(redirectUri, parameters);
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  url.searchParams.set('iss', issuer);
  return { method: 'redirect', location: url.toString() };
}

/**
 * Send the authorization response to the client: a 302 to the URL that
 * carries it, or the HTML form a form_post response is posted from
 * (formPostPage() in _oidc-provider/html.ts), with the given cookies attached.
 */
export function respondToClient(response: AuthorizationResponse, cookies: readonly string[] = []): Response {
  const answer =
    response.method === 'redirect'
      ? NextResponse.redirect(response.location, 302)
      : formPostPage(response.action, response.fields);
  for (const cookie of cookies) {
    answer.headers.append('Set-Cookie', cookie);
  }
  return answer;
}
