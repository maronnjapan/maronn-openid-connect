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
 * `upstreamLogins` を使う `nonce` のストアを返す。
 *
 * 返すのは `@maronn-openid-connect/google-login` の `GoogleLoginNonceStore` の実装で、レコードは OP のストアのうち外部でのログインを記録するもの（`db/` の `upstreamLoginStore`）に保存する。
 * パッケージはキーを `'google_login_nonce:'` と `nonce` をつないだ値にするが、ストアには接頭辞を除いた `nonce` だけを、送り先の ID プロバイダの名前（`'google'`）と一緒に保存する。
 * `get()` は、レコードがないときと、ID プロバイダが `'google'` でないときに `null` を返す。
 *
 * レコードはトランザクションと同じ期限（`expiresAt`）まで有効で、`login_uri` の処理が最初に使ったときに削除する。
 * `put()` は `ttlSeconds` を使わず、期限には `expiresAt` を使う。
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
 * Google アカウントから `FederatedIdentity` を作る。
 *
 * `provider` は `'google'`、`subject` は Google の `sub` にする。
 * クレームは、Google が値を入れたプロフィールとメールアドレスのクレーム（`name`、`given_name`、`family_name`、`picture`、`locale`、`email`、`email_verified`）だけを写す。
 * UserInfo エンドポイントが、Google がそのアカウントについて示した値だけを返すようにするためである。
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
