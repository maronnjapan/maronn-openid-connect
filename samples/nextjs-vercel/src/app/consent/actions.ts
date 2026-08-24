'use server';

import { redirect } from 'next/navigation';
import {
  getAuthTransaction,
  validateCsrfToken,
  completeAuthTransaction,
  createAuthorizationCode,
} from '@maronn-openid-connect/core';
import { oidcProviderOptions } from '../_oidc-provider/runtime';
import { createStoreResolvers } from '../_oidc-provider/resolvers';
import { defaultProviderStores } from '../_oidc-provider/store';

const providerStores = oidcProviderOptions.storage ?? defaultProviderStores;
const { transactionStore, authCodeStore, authSessionStore } = providerStores;
const { consentResolver } = createStoreResolvers(providerStores);

/**
 * Consent Server Action.
 *
 * Mirrors the framework-neutral consent route. Reuses the same issuer / client
 * resolver as the route handlers via oidcProviderOptions so the issued code and
 * recorded consent stay consistent with the rest of the provider.
 */
export async function consentAction(formData: FormData): Promise<void> {
  const transactionId = String(formData.get('transaction_id') ?? '');
  const csrfToken = String(formData.get('csrf_token') ?? '');
  const action = String(formData.get('action') ?? '');

  const transaction = await getAuthTransaction(transactionId, transactionStore);
  validateCsrfToken(transaction, csrfToken);

  // RFC 9207 §2: include the issuer identifier on every authorization response.
  const issuer = oidcProviderOptions.config?.issuer ?? '';

  if (action === 'deny') {
    const denyUrl = new URL(transaction.redirectUri);
    denyUrl.searchParams.set('error', 'access_denied');
    if (transaction.state) {
      denyUrl.searchParams.set('state', transaction.state);
    }
    denyUrl.searchParams.set('iss', issuer);
    await transactionStore.delete('auth_txn:' + transactionId);
    await authSessionStore.delete(transactionId);
    redirect(denyUrl.toString());
  }

  // OIDC Core 1.0 Section 3.1.2.4: "the Authorization Server MUST obtain an
  // authorization decision before releasing information to the Relying Party."
  // This action mints the authorization code, so it detects the affirmative
  // decision on an allowlist just like the route handlers: a missing, empty or
  // unknown 'action' means no decision was obtained and must not approve.
  //
  // 'approve' is the decision value this provider accepts, and it MUST stay in
  // sync with the Approve button in consent/page.tsx.
  //
  // Section 3.1.2.6: access_denied means the End-User denied the request, which
  // is not the same as no decision at all — an unrecognized value therefore goes
  // to the OP's own error page instead of back to the client.
  if (action !== 'approve') {
    redirect(
      '/oidc-error?error=invalid_request&error_description=' +
        encodeURIComponent('Invalid consent decision. Please use the Approve or Deny button.'),
    );
  }

  const session = await authSessionStore.get(transactionId);
  if (!session) {
    redirect(`/login?transaction_id=${encodeURIComponent(transactionId)}`);
  }

  const responseParams = await completeAuthTransaction(
    transactionId,
    transaction,
    transactionStore,
  );

  // transaction.scope は認可リクエスト検証時に applyOfflineAccessPolicy を通した後の値。
  // offline_access の可否（OIDC Core 1.0 §11 の prompt=consent と、クライアント登録
  // grant_types に refresh_token があるか）はそこで確定しているので再フィルタしない。
  const grantedScope = transaction.scope.split(' ').filter(Boolean);

  // OIDC Core 1.0 Section 3.1.3.1: TTL is configurable via ProviderConfig.
  const authCodeData = await createAuthorizationCode({
    authorizationResponse: { ...responseParams, scope: grantedScope },
    subject: session.subject,
    authTime: session.authTime,
    // online refresh token をこのログインセッションへ束縛する（login フローが
    // authSessionStore へ載せた値）。ログアウトすれば RT も使えなくなる。
    sessionId: session.sessionId,
    ttlSeconds: oidcProviderOptions.config?.authorizationCodeTtl,
  });
  await authCodeStore.set(authCodeData.code, authCodeData);

  // Record consent so a later prompt=none request can confirm it without UI
  // (OIDC Core 1.0 Section 3.1.2.4).
  await consentResolver.recordConsent?.(
    session.subject,
    transaction.clientId,
    grantedScope,
  );

  await authSessionStore.delete(transactionId);

  const successUrl = new URL(responseParams.redirectUri);
  successUrl.searchParams.set('code', authCodeData.code);
  if (responseParams.state) {
    successUrl.searchParams.set('state', responseParams.state);
  }
  successUrl.searchParams.set('iss', issuer);
  redirect(successUrl.toString());
}
