import { NextResponse } from 'next/server';
import {
  AuthTransactionError,
  AuthTransactionErrorCode,
  buildTransactionPath,
  getAuthTransaction,
  getTransactionIdFromUrl,
  handleLoginFailure,
  validateCsrfToken,
  validateTransactionId,
} from '@maronn-openid-connect/core';
import { readFormFields, redirectToErrorPage } from '../../_oidc-provider/http';
import { config, stores } from '../../_oidc-provider/provider';
import {
  CROSS_ORIGIN_FORM_POST_MESSAGE,
  isSameOriginFormPost,
  parseTransactionId,
} from '../../_oidc-provider/cookies';
import { startSession } from '../session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Authenticate a form only when its cookie, URL and hidden transaction IDs match and its CSRF token is valid, then continue to consent. */
export async function POST(request: Request): Promise<Response> {
  // [reject-cross-origin-post] Check the browser's origin before loading any transaction.
  const sameOrigin = isSameOriginFormPost(
    { origin: request.headers.get('Origin'), secFetchSite: request.headers.get('Sec-Fetch-Site') },
    config.issuer,
  );
  if (!sameOrigin) return redirectToErrorPage('cross_origin_request', CROSS_ORIGIN_FORM_POST_MESSAGE);

  // [load-transaction] All three references must name the same live transaction.
  const form = await readFormFields(request);
  const transactionId = parseTransactionId(request.headers.get('Cookie'));
  let transaction;
  try {
    validateTransactionId(transactionId, [
      getTransactionIdFromUrl(request.url),
      form.getAll('transaction_id').length === 1 ? form.get('transaction_id') : undefined,
    ]);
    transaction = await getAuthTransaction(transactionId, stores.transactionStore);
  } catch (error) {
    if (error instanceof AuthTransactionError) return redirectToErrorPage(error.code, error.message);
    throw error;
  }

  // [validate-csrf-token] Verify the token before credentials, failure counters or sessions change.
  try {
    validateCsrfToken(transaction, String(form.get('csrf_token') ?? ''));
  } catch (error) {
    if (error instanceof AuthTransactionError) return redirectToErrorPage(error.code, error.message);
    throw error;
  }

  // [authenticate-user] Authenticate against the configured user store.
  const user = await stores.userStore.authenticate(
    String(form.get('username') ?? ''),
    String(form.get('password') ?? ''),
  );
  if (!user) {
    // [record-login-failure] Keep the transaction ID when retrying the same form.
    const failure = await handleLoginFailure(transactionId, transaction, stores.transactionStore);
    if (!failure.canRetry) {
      return redirectToErrorPage(
        AuthTransactionErrorCode.MaxAttemptsExceeded,
        'Too many login attempts. Start again from the application.',
      );
    }
    const retry = new URL(buildTransactionPath('/login', transactionId), config.issuer);
    retry.searchParams.set('error', 'invalid_credentials');
    retry.searchParams.set('remaining', String(failure.maxAttempts - failure.failedAttempts));
    return NextResponse.redirect(retry, 303);
  }

  // [establish-session] Start the browser session and hand it to this transaction's consent step.
  await startSession(transactionId, transaction, user.sub);
  return NextResponse.redirect(new URL(buildTransactionPath('/consent', transactionId), config.issuer), 303);
}
