/**
 * Login screen (screen routing layer).
 *
 * GET /login renders the form. The logic behind the form — credential check,
 * lockout, session cookie, hand-off to /consent — is POST /login in
 * routes/login.ts, which comes back to renderLoginPage() whenever it has to
 * show the form again. To customize the login UI, edit this file or the
 * loginPage view in views.ts; routes/login.ts never has to change.
 */
import { Hono } from 'hono';
import {
  getAuthTransaction,
  validateTransactionBinding,
  AuthTransactionError,
  type AuthTransaction,
} from '@maronn-openid-connect/core';
import {
  transactionStore as defaultTransactionStore,
  parseTransactionBindingSecret,
} from '../store.js';
import { defaultViews, renderView, type LoginPageParams } from '../views.js';
import { renderErrorPage } from './errors.js';

export const loginPage = new Hono<{ Variables: Record<string, any> }>();

/**
 * Render the login form.
 *
 * Shared by GET /login (below) and by the failed-attempt path of POST /login
 * (routes/login.ts), so both come out of one function: swap the view, return a
 * framework-rendered Response, or redirect to a UI of your own — here only.
 */
export function renderLoginPage(c: any, params: LoginPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.loginPage(params));
}

/**
 * Enforce that this step comes from the User-Agent that started the transaction
 * (OIDC Core 1.0 Section 3.1.2.3 / 3.1.2.4). Returns an error Response to send
 * back, or undefined when the binding holds.
 *
 * Shared by GET /login (below) and POST /login (routes/login.ts): the page
 * decides who may see the form, and the API applies the same rule before it
 * acts on the form. The failure is rendered by the OP itself and never
 * redirected to the client's redirect_uri: at this point we cannot tell whose
 * transaction this is, so answering the client would leak that a transaction
 * exists — and, in the lured-victim case, would hand the attacker's client a
 * code for the victim. See buildTransactionBindingCookie() in store.ts.
 */
export async function rejectUnboundTransaction(
  c: any,
  transaction: AuthTransaction,
  transactionId: string,
): Promise<Response | undefined> {
  try {
    await validateTransactionBinding(
      transaction,
      parseTransactionBindingSecret(c.req.header('Cookie') ?? null, transactionId),
    );
    return undefined;
  } catch (error) {
    if (!(error instanceof AuthTransactionError)) throw error;
    return renderErrorPage(c, {
      error: error.message,
      statusCode: error.httpStatusCode,
    });
  }
}

/**
 * Login Page - GET
 * Displays the login form for user authentication.
 */
loginPage.get('/', async (c) => {
  const transactionId = c.req.query('transaction_id');
  if (!transactionId) {
    return c.text('Missing transaction_id', 400);
  }

  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const transaction = await getAuthTransaction(transactionId, transactionStore);

  // Checked BEFORE rendering: the login page embeds csrf_token, so anyone who
  // could load this page with a leaked transaction_id would obtain the token
  // that the POST handler validates.
  const bindingError = await rejectUnboundTransaction(c, transaction, transactionId);
  if (bindingError) return bindingError;

  return renderLoginPage(c, {
    transactionId,
    csrfToken: transaction.csrfToken,
    // OIDC Core 1.0 §3.1.2.1: pre-fill the login form with login_hint (RECOMMENDED).
    loginHint: transaction.loginHint,
  });
});
