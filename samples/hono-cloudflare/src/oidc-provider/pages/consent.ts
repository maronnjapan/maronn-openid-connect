/**
 * Consent screen (screen routing layer).
 *
 * GET /consent renders the approve / deny form. The decision itself — CSRF
 * check, authorization code, consent record, redirect back to the client — is
 * POST /consent in routes/consent.ts. To customize the consent UI, edit this
 * file or the consentPage view in views.ts; routes/consent.ts never has to
 * change. Keep the two button values ('approve' / 'deny') as they are: the
 * POST handler accepts exactly those.
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
import { defaultViews, renderView, type ConsentPageParams } from '../views.js';
import { renderErrorPage } from './errors.js';

export const consentPage = new Hono<{ Variables: Record<string, any> }>();

/**
 * Render the consent form. Swap the view, return a framework-rendered Response,
 * or redirect to a UI of your own — here only.
 */
export function renderConsentPage(c: any, params: ConsentPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.consentPage(params));
}

/**
 * Enforce that this step comes from the User-Agent that started the transaction
 * (OIDC Core 1.0 Section 3.1.2.3 / 3.1.2.4). Returns an error Response to send
 * back, or undefined when the binding holds.
 *
 * Shared by GET /consent (below) and POST /consent (routes/consent.ts): the
 * page decides who may see the form, and the API applies the same rule before
 * it mints the authorization code. The failure is rendered by the OP itself and
 * never redirected to the client's redirect_uri: without a verified owner,
 * answering the client would let an attacker who lured a victim into their own
 * transaction collect a code for the victim's identity. See
 * buildTransactionBindingCookie() in store.ts.
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
 * Consent Page - GET
 * Displays the consent form for scope authorization.
 */
consentPage.get('/', async (c) => {
  const transactionId = c.req.query('transaction_id');
  if (!transactionId) {
    return c.text('Missing transaction_id', 400);
  }

  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const transaction = await getAuthTransaction(transactionId, transactionStore);

  // Checked BEFORE rendering: the consent page embeds csrf_token, so a third
  // party holding a leaked transaction_id must not be able to read it here and
  // then complete POST /consent on the End-User's behalf.
  const bindingError = await rejectUnboundTransaction(c, transaction, transactionId);
  if (bindingError) return bindingError;

  return renderConsentPage(c, {
    transactionId,
    csrfToken: transaction.csrfToken,
    scopes: transaction.scope.split(' ').filter(Boolean),
    clientId: transaction.clientId,
  });
});
