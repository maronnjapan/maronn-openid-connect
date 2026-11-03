/**
 * What the login screen shows and what its form submits, and the outcomes the
 * login steps report to page.tsx.
 */

import { AuthTransactionError } from '@maronn-openid-connect/core';
import type { ViewResult } from '../../views.js';

/** What the login form needs: prepared for GET /login and again after a failed attempt. */
export interface LoginScreen {
  kind: 'screen';
  /**
   * Must be posted back as the csrf_token field. It is the only value the form
   * carries about the transaction: the transaction itself travels in the
   * transaction cookie, and POST /login accepts the token only for that one.
   */
  csrfToken: string;
  /**
   * OIDC Core 1.0 §3.1.2.1 login_hint: untrusted external value the OP MAY use
   * to pre-fill the login form.
   */
  loginHint?: string;
  /**
   * The other ways to sign in the features offer (loginMethods of
   * features/feature.ts), rendered for this transaction.
   */
  loginMethods: ViewResult[];
}

/** A failure the OP shows on its own error page (never redirected to the client). */
export interface LoginError {
  kind: 'error';
  error: string;
  errorDescription?: string;
  statusCode: number;
}

/** What POST /login decided; page.tsx turns it into HTTP. */
export type LoginOutcome =
  | LoginError
  /** handleLoginFailure() locked the transaction: no further attempt is accepted (429). */
  | { kind: 'locked_out' }
  /** Wrong credentials: show the form again with the attempts left. */
  | { kind: 'invalid_credentials'; screen: LoginScreen; remainingAttempts: number }
  /** Signed in: the OP session cookie(s) to set, then continue to the consent step. */
  | { kind: 'authenticated'; cookies: string[] };

/** The fields of the login form. */
export interface LoginSubmission {
  csrfToken: string;
  username: string;
  password: string;
}

/**
 * トランザクションのエラーを、画面に出すエラーに変える。
 *
 * ステータスコードには、エラーの `httpStatusCode` を使う。
 * トランザクションが見つからないとき（すでに終わったものを含む）と期限切れのときは 400、`csrf_token` がトランザクションのものでないときは 403 になる。
 *
 * このエラーは OP のエラーページに表示し、クライアントの `redirect_uri` へはリダイレクトしない。
 * トランザクションと `csrf_token` を確かめるまでは、誰のリクエストかを OP が判別できないためである。
 *
 * @throws 受け取った `error` が `AuthTransactionError` でないときは、それをそのまま投げる。
 */
export function transactionErrorOutcome(error: unknown): LoginError {
  if (!(error instanceof AuthTransactionError)) throw error;
  return { kind: 'error', error: error.message, statusCode: error.httpStatusCode };
}
