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
import { WebRouter } from '../web-router.js';
import {
  getAuthTransaction,
} from '@maronn-openid-connect/core';
import {
  transactionStore as defaultTransactionStore,
} from '../store.js';
import { defaultViews, renderView, type ConsentPageParams } from '../views.js';

export const consentPage = new WebRouter();

/**
 * Render the consent form. Swap the view, return a framework-rendered Response,
 * or redirect to a UI of your own — here only.
 */
export function renderConsentPage(c: any, params: ConsentPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.consentPage(params));
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

  return renderConsentPage(c, {
    transactionId,
    csrfToken: transaction.csrfToken,
    scopes: transaction.scope.split(' ').filter(Boolean),
    clientId: transaction.clientId,
  });
});
