/**
 * What the consent screen shows and what its form submits, and the outcomes
 * the consent steps report to page.tsx.
 */

import {
  AuthTransactionError,
  type AuthorizationCodeData,
  type AuthorizationResponseParams,
} from '@maronn-openid-connect/core';
import type { ClientDisplay } from '../../client-display.js';
import type { AuthorizationResponse } from '../authorize/response-mode.js';

/** What the consent form needs, prepared for GET /consent. */
export interface ConsentScreen {
  kind: 'screen';
  /**
   * Must be posted back as the csrf_token field. It is the only value the form
   * carries about the transaction: the transaction itself travels in the
   * transaction cookie, and POST /consent accepts the token only for that one.
   */
  csrfToken: string;
  /** Scopes this End-User is asked to grant (already narrowed by the scope policy). */
  scopes: string[];
  /** Client requesting the authorization. */
  clientId: string;
  /**
   * The client as the page shows it (OIDC Dynamic Client Registration 1.0 §2):
   * client_name, logo_uri, policy_uri, tos_uri and client_uri (client-display.ts).
   */
  client: ClientDisplay;
}

/** A failure the OP shows on its own error page (never redirected to the client). */
export interface ConsentError {
  kind: 'error';
  error: string;
  errorDescription?: string;
  statusCode: number;
}

/** What POST /consent decided; page.tsx turns it into HTTP. */
export type ConsentOutcome =
  | ConsentError
  /**
   * OIDC Core 1.0 Section 3.1.2.4: no decision was obtained — action was
   * missing, empty or unknown. Not access_denied (Section 3.1.2.6), so the
   * browser stays on the OP (400).
   */
  | { kind: 'invalid_decision' }
  /** No authenticated subject for this transaction: the login step was skipped or expired (400). */
  | { kind: 'session_missing' }
  /** Approved or denied: the authorization response for the client, in the response mode the request asked for. */
  | { kind: 'authorization_response'; response: AuthorizationResponse; cookies: string[] };

/** The fields of the consent form. */
export interface ConsentSubmission {
  csrfToken: string;
  /** 'approve' or 'deny' — the submit button values of the consent view. */
  action: string;
}

/** What the approved request was issued: the response parameters, the code and the granted scope. */
export interface ConsentedAuthorization {
  responseParams: AuthorizationResponseParams;
  authCodeData: AuthorizationCodeData;
  grantedScope: string[];
}

/**
 * トランザクションのエラーを、画面に出すエラーに変える。
 *
 * ステータスコードには、エラーの `httpStatusCode` を使う。
 * トランザクションが見つからないとき（すでに終わったものを含む）と期限切れのときは 400、`csrf_token` がトランザクションのものでないときは 403 になる。
 *
 * このエラーは OP のエラーページに表示し、クライアントの `redirect_uri` へはリダイレクトしない。
 * トランザクションと `csrf_token` を確かめるまでは誰のリクエストかを OP が判別できず、クライアントへ応答すると、このエンドユーザーの認可コードを別人に渡すおそれがあるためである。
 *
 * @throws 受け取った `error` が `AuthTransactionError` でないときは、それをそのまま投げる。
 */
export function transactionErrorOutcome(error: unknown): ConsentError {
  if (!(error instanceof AuthTransactionError)) throw error;
  return { kind: 'error', error: error.message, statusCode: error.httpStatusCode };
}
