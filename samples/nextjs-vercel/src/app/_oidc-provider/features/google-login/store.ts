import type { UserClaims } from '@maronn-openid-connect/core';
import type {
  GoogleIdTokenPayload,
  GoogleLoginNonceRecord,
  GoogleLoginNonceStore,
} from '@maronn-openid-connect/google-login';
import type { FederatedIdentity, UpstreamLoginStorage } from '../../store';

/** The upstream provider name the Google sign-ins are stored under. */
export const GOOGLE_PROVIDER = 'google';

/** The key prefix @maronn-openid-connect/google-login puts before every nonce. */
const GOOGLE_LOGIN_NONCE_KEY_PREFIX = 'google_login_nonce:';

/**
 * EXTENSION (google-login): the nonce store of the package, on the upstream
 * logins of the provider's stores (upstreamLoginStore of db/). The package
 * keys a nonce as 'google_login_nonce:' + nonce; the stores keep the nonce
 * alone, with the provider it was sent to. The record lives as long as its
 * transaction (expiresAt), and the callback deletes it on first use.
 */
export function createGoogleLoginNonceStore(upstreamLogins: UpstreamLoginStorage): GoogleLoginNonceStore {
  const nonceOf = (key: string): string =>
    key.startsWith(GOOGLE_LOGIN_NONCE_KEY_PREFIX) ? key.slice(GOOGLE_LOGIN_NONCE_KEY_PREFIX.length) : key;
  return {
    async get(key: string): Promise<GoogleLoginNonceRecord | null> {
      const login = await upstreamLogins.find(nonceOf(key));
      if (!login || login.provider !== GOOGLE_PROVIDER) return null;
      return { transactionId: login.transactionId, expiresAt: login.expiresAt };
    },
    async put(key: string, record: GoogleLoginNonceRecord): Promise<void> {
      await upstreamLogins.save(nonceOf(key), {
        provider: GOOGLE_PROVIDER,
        transactionId: record.transactionId,
        expiresAt: record.expiresAt,
      });
    },
    async delete(key: string): Promise<void> {
      await upstreamLogins.delete(nonceOf(key));
    },
  };
}

/**
 * EXTENSION (google-login): the federated identity of a verified Google
 * account. Only the profile / email claims Google supplied are copied, so the
 * UserInfo endpoint returns exactly what Google asserted about the account.
 */
export function googleAccountToFederatedIdentity(account: GoogleIdTokenPayload): FederatedIdentity {
  const claims: Omit<UserClaims, 'sub'> = {};
  if (account.name !== undefined) claims.name = account.name;
  if (account.given_name !== undefined) claims.given_name = account.given_name;
  if (account.family_name !== undefined) claims.family_name = account.family_name;
  if (account.picture !== undefined) claims.picture = account.picture;
  if (account.locale !== undefined) claims.locale = account.locale;
  if (account.email !== undefined) claims.email = account.email;
  if (account.email_verified !== undefined) claims.email_verified = account.email_verified;
  return { provider: GOOGLE_PROVIDER, subject: account.sub, claims };
}
