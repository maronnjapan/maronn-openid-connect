'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import {
  getAuthTransaction,
  validateCsrfToken,
  handleLoginFailure,
  generateRandomString,
} from '@maronn-openid-connect/core';
import { oidcProviderOptions } from '../_oidc-provider/runtime';
import { defaultProviderStores, SESSION_COOKIE_NAME } from '../_oidc-provider/store';

const {
  transactionStore,
  authSessionStore,
  browserSessionStore,
  userStore,
} = oidcProviderOptions.storage ?? defaultProviderStores;

/**
 * Login Server Action.
 *
 * Mirrors the framework-neutral login route, but runs as a Next.js Server
 * Action so the UI can stay a plain React `page.tsx`. On failure it redirects
 * back to the login page with an error so the page can re-render the message.
 */
export async function loginAction(formData: FormData): Promise<void> {
  const transactionId = String(formData.get('transaction_id') ?? '');
  const csrfToken = String(formData.get('csrf_token') ?? '');
  const username = String(formData.get('username') ?? '');
  const password = String(formData.get('password') ?? '');

  const transaction = await getAuthTransaction(transactionId, transactionStore);
  validateCsrfToken(transaction, csrfToken);

  const user = await userStore.authenticate(username, password);
  if (!user) {
    const failureResult = await handleLoginFailure(
      transactionId,
      transaction,
      transactionStore,
    );
    if (!failureResult.canRetry) {
      redirect(
        `/login?transaction_id=${encodeURIComponent(transactionId)}&error=too_many_attempts`,
      );
    }
    const remaining = failureResult.maxAttempts - failureResult.failedAttempts;
    redirect(
      `/login?transaction_id=${encodeURIComponent(transactionId)}&error=invalid_credentials&remaining=${remaining}`,
    );
  }

  const cookieStore = await cookies();

  // prompt=login / select_account requires fresh authentication: discard any
  // existing transaction handoff AND browser session.
  // OIDC Core 1.0 Section 3.1.2.1 — prompt is a space-delimited list.
  const loginPromptValues = transaction.prompt?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (loginPromptValues.includes('login') || loginPromptValues.includes('select_account')) {
    await authSessionStore.delete(transactionId);
    const existingSessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    if (existingSessionId) await browserSessionStore.delete(existingSessionId);
  }

  const authTime = Math.floor(Date.now() / 1000);

  // Establish a persistent browser (OP) session so SSO / prompt=none / max_age
  // work on subsequent authorization requests (OIDC Core 1.0 Section 3.1.2.3).
  // Cookie attributes match buildSessionCookie() in store.ts so the
  // sessionResolver can read it back.
  const sessionId = await generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject: user.sub, authTime });

  // Store authenticated subject for the consent step (per-transaction handoff).
  // sessionId も渡すのは online refresh token のため。consent 経由で発行する認可
  // コードにこのセッションを引き継ぎ、ログアウトで使えなくなる RT を作る。
  await authSessionStore.set(transactionId, {
    subject: user.sub,
    authTime,
    sessionId,
  });
  cookieStore.set(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  });

  redirect(`/consent?transaction_id=${encodeURIComponent(transactionId)}`);
}
