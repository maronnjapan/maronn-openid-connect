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
import type { RegisteredClient } from '../_oidc-provider/config';
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

  const session = await authSessionStore.get(transactionId);
  if (!session) {
    redirect(`/login?transaction_id=${encodeURIComponent(transactionId)}`);
  }

  const responseParams = await completeAuthTransaction(
    transactionId,
    transaction,
    transactionStore,
  );

  // Filter offline_access if the client does not allow it.
  // findClient() is typed as ClientResolver here, so narrow back to the
  // registered-client shape that carries offlineAccessAllowed.
  const clientConfig = (await oidcProviderOptions.clientResolver?.findClient(
    transaction.clientId,
  )) as RegisteredClient | null | undefined;
  const grantedScope = transaction.scope.split(' ').filter((s) => {
    if (s === 'offline_access' && !clientConfig?.offlineAccessAllowed) return false;
    return Boolean(s);
  });

  // OIDC Core 1.0 Section 3.1.3.1: TTL is configurable via ProviderConfig.
  const authCodeData = await createAuthorizationCode({
    authorizationResponse: { ...responseParams, scope: grantedScope },
    subject: session.subject,
    authTime: session.authTime,
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
