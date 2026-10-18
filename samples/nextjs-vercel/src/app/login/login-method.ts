/**
 * A way to sign in that the login page offers next to the password form.
 *
 * A feature lists its login methods in the loginMethods entry of its
 * feature.ts; page.tsx shows each one that renders something for the
 * transaction. The page hands it the settings and the stores, so the module of
 * a login method does not import provider.ts: features.ts reaches it, and
 * provider.ts reads features.ts.
 */
import type { ReactNode } from 'react';
import type { AuthTransaction } from '@maronn-openid-connect/core';
import type { ProviderConfig } from '../_oidc-provider/config';
import type { ProviderStores } from '../_oidc-provider/store';

export interface LoginMethod {
  /** A name for the method, such as 'google'. */
  readonly id: string;
  /**
   * What the login page shows for the method, for this transaction; undefined
   * to show nothing (the method is not configured).
   */
  render(input: {
    transactionId: string;
    transaction: AuthTransaction;
    config: ProviderConfig;
    stores: ProviderStores;
  }): Promise<ReactNode | undefined>;
}
