/**
 * ProviderStores (store.ts) on the Maps of database.ts: the stores the OP uses
 * when no other storage is passed in.
 *
 * They behave like the stores of --db sql and --db kv, which the endpoints and
 * resolvers.ts rely on:
 *
 * 1. authCodeStore.consume and refreshTokenStore.consume throw TokenError
 *    (invalid_grant) for a code or token that is already used, so of two
 *    requests that present the same one, only one receives tokens
 *    (OAuth 2.1 §4.1.2).
 * 2. consume never deletes the record. A used code or a rotated refresh token
 *    has to stay readable, so a replay is detected and the grant's tokens
 *    revoked.
 * 3. get never returns an expired record (and removes it), and does return
 *    used ones.
 * 4. revokeByGrantId also removes the rotated (used) refresh tokens of the grant.
 * 5. hasConsent is true only when every requested scope was granted.
 */
import {
  TokenError,
  TokenErrorCode,
  type AuthTransactionStore,
  type UserClaims,
} from '@maronn-openid-connect/core';
import type {
  AccessTokenStorage,
  AuthSessionStorage,
  AuthorizationCodeStorage,
  BrowserSessionStorage,
  ClientAssertionJtiStorage,
  ConsentStorage,
  ProviderStores,
  RefreshTokenStorage,
  UpstreamLoginStorage,
  UserStorage,
} from '../../store.js';
import { federatedIdentityKey, type MemoryDatabase } from './database.js';
import { verifyPassword } from './users.js';

/**
 * メモリ上のデータに読み書きする OP のストアを返す。
 *
 * 返すのは、トランザクション、認可コード、アクセストークン、リフレッシュトークン、ログインの結果、ブラウザのセッション、同意、ユーザー、外部の ID プロバイダでのログイン、使用済みのクライアントアサーションの `jti` のストアである。
 * 有効期限のあるエントリーは読むときに有効期限を確かめ、期限切れなら返さずに取り除く。
 *
 * 返したストアの `authCodeStore.consume()` と `refreshTokenStore.consume()` は、使用済みか見つからない認可コードとトークンには `TokenError`（`invalid_grant`）を投げる。
 * 同じ値を提示した二つのリクエストのうち、トークンを受け取るのは一方だけである（OAuth 2.1 §4.1.2）。
 */
export function createProviderStores(db: MemoryDatabase): ProviderStores {
  const transactionStore: AuthTransactionStore = {
    async get(key) {
      const entry = db.transactions.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        db.transactions.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key, value, ttlSeconds) {
      db.transactions.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async delete(key) {
      db.transactions.delete(key);
    },
  };

  const authCodeStore: AuthorizationCodeStorage = {
    set(code, info) {
      db.codes.set(code, { ...info });
    },
    get(code) {
      const entry = db.codes.get(code);
      if (!entry) return undefined;
      if (entry.expiresAt <= nowSeconds()) {
        db.codes.delete(code);
        return undefined;
      }
      return { ...entry };
    },
    consume(code) {
      const entry = db.codes.get(code);
      if (!entry || entry.used) {
        throw new TokenError(TokenErrorCode.InvalidGrant, 'Authorization code has already been used');
      }
      entry.used = true;
    },
    delete(code) {
      db.codes.delete(code);
    },
  };

  const accessTokenStore: AccessTokenStorage = {
    set(token, info) {
      db.accessTokens.set(token, { ...info });
    },
    get(token) {
      const entry = db.accessTokens.get(token);
      if (!entry) return undefined;
      // 期限切れのエントリーは、読んだときに取り除く（RFC 6819 §5.1.5.3、RFC 9700 §4.14）。
      // 使われなくなったエントリーがたまって、データベースが際限なく大きくならないようにするためである。
      // 期限切れのトークンを受け付けないことは core の有効期限の確認で成り立っており、ここで取り除くのは保持する量を抑えるためだけである。
      if (entry.expiresAt <= nowSeconds()) {
        db.accessTokens.delete(token);
        return undefined;
      }
      return { ...entry };
    },
    delete(token) {
      db.accessTokens.delete(token);
    },
    revokeByGrantId(grantId) {
      for (const [token, info] of db.accessTokens) {
        if (info.grantId === grantId) db.accessTokens.delete(token);
      }
    },
    revoke(token) {
      db.accessTokens.delete(token);
    },
  };

  const refreshTokenStore: RefreshTokenStorage = {
    set(token, info) {
      db.refreshTokens.set(token, { ...info });
    },
    get(token) {
      const entry = db.refreshTokens.get(token);
      if (!entry) return undefined;
      // 取り除くのは、絶対的な有効期限（`expiresAt`）を過ぎたエントリーだけである。
      // 使用済みでも有効期限内のエントリーは残すので、ローテーション後の再利用を検出し続けられる（OAuth 2.1 §4.3.1、RFC 9700 §4.13）。
      if (entry.expiresAt <= nowSeconds()) {
        db.refreshTokens.delete(token);
        return undefined;
      }
      return { ...entry };
    },
    consume(token) {
      const entry = db.refreshTokens.get(token);
      if (!entry || entry.used) {
        throw new TokenError(TokenErrorCode.InvalidGrant, 'Refresh token has already been used');
      }
      entry.used = true;
    },
    delete(token) {
      db.refreshTokens.delete(token);
    },
    revokeByGrantId(grantId) {
      for (const [token, info] of db.refreshTokens) {
        if (info.grantId === grantId) db.refreshTokens.delete(token);
      }
    },
    revoke(token) {
      db.refreshTokens.delete(token);
    },
  };

  const authSessionStore: AuthSessionStorage = {
    set(transactionId, info) {
      db.authSessions.set(transactionId, { ...info });
    },
    get(transactionId) {
      const entry = db.authSessions.get(transactionId);
      return entry ? { ...entry } : undefined;
    },
    delete(transactionId) {
      db.authSessions.delete(transactionId);
    },
  };

  const browserSessionStore: BrowserSessionStorage = {
    set(sessionId, info) {
      db.browserSessions.set(sessionId, { ...info });
    },
    get(sessionId) {
      const entry = db.browserSessions.get(sessionId);
      return entry ? { ...entry } : undefined;
    },
    delete(sessionId) {
      db.browserSessions.delete(sessionId);
    },
  };

  const consentStore: ConsentStorage = {
    grant(subject, clientId, scopes) {
      const granted = entryOf(db.consentScopes, subject, clientId);
      for (const scope of scopes) granted.add(scope);
    },
    hasConsent(subject, clientId, scopes) {
      const granted = db.consentScopes.get(subject)?.get(clientId);
      if (!granted || scopes.length === 0) return false;
      return scopes.every((scope) => granted.has(scope));
    },
    recordGrant(subject, clientId, grantId) {
      entryOf(db.consentGrants, subject, clientId).add(grantId);
    },
    // サブジェクトがクライアントに与えた同意を消し（アクセスの取り消し）、記録していたグラント ID を返す。
    // 呼び出し側は、返されたグラントごとにトークンを失効させる。
    revoke(subject, clientId) {
      const grantIds = [...(db.consentGrants.get(subject)?.get(clientId) ?? [])];
      db.consentScopes.get(subject)?.delete(clientId);
      db.consentGrants.get(subject)?.delete(clientId);
      return grantIds;
    },
  };

  const userStore: UserStorage = {
    // パスワードのフォームでは、ユーザーの `sub` をユーザー名として照合する。
    async authenticate(username, password) {
      const user = db.users.get(username);
      // `verifyPassword()` はハッシュがなくても同じだけ時間をかけるので、応答までの時間からユーザーの有無はわからない。
      // パスワードのないユーザー（外部の ID プロバイダでのログインで作られたユーザー）は、フォームではログインできない。
      const passwordHash = user?.passwordHash ?? null;
      if (!(await verifyPassword(password, passwordHash)) || !user || passwordHash === null) {
        return undefined;
      }
      return { ...user.claims, password: passwordHash };
    },
    getClaims(sub) {
      const user = db.users.get(sub);
      return user ? { ...user.claims } : undefined;
    },
    // 検証済みの外部アカウントのユーザーを紐付けから探し、なければ新しいランダムな `sub` で作る（メールアドレスでは探さない）。
    // そのうえで、外部の ID プロバイダから受け取ったクレームを保存して返す。
    linkFederatedIdentity(identity) {
      const key = federatedIdentityKey(identity.provider, identity.subject);
      const sub = db.federatedIdentities.get(key) ?? crypto.randomUUID();
      db.federatedIdentities.set(key, sub);
      const claims: UserClaims = { ...identity.claims, sub };
      db.users.set(sub, { ...db.users.get(sub), claims });
      return { ...claims };
    },
  };

  const upstreamLoginStore: UpstreamLoginStorage = {
    find(nonce) {
      const login = db.upstreamLogins.get(nonce);
      if (!login) return undefined;
      if (login.expiresAt <= Date.now()) {
        db.upstreamLogins.delete(nonce);
        return undefined;
      }
      return { ...login };
    },
    // トランザクションが待つ外部の ID プロバイダでのログインは一つなので、新しいログイン画面の `nonce` が古い画面の `nonce` を置き換える。
    save(nonce, login) {
      for (const [other, pending] of db.upstreamLogins) {
        if (pending.transactionId === login.transactionId) db.upstreamLogins.delete(other);
      }
      db.upstreamLogins.set(nonce, { ...login });
    },
    delete(nonce) {
      db.upstreamLogins.delete(nonce);
    },
  };

  // 使用済みの `jti` を、アサーションが期限切れになるまで覚える（RFC 7523 §3）。
  // 読み書きは同じ同期の処理の中で行うので、同じキーで `true` を返すのは一度だけである。
  const clientAssertionJtiStore: ClientAssertionJtiStorage = {
    consume(key, expiresAt) {
      const now = nowSeconds();
      const remembered = db.clientAssertionJtis.get(key);
      if (remembered !== undefined && remembered > now) return false;
      for (const [other, otherExpiresAt] of db.clientAssertionJtis) {
        if (otherExpiresAt <= now) db.clientAssertionJtis.delete(other);
      }
      db.clientAssertionJtis.set(key, expiresAt);
      return true;
    },
  };

  return {
    transactionStore,
    authCodeStore,
    accessTokenStore,
    refreshTokenStore,
    authSessionStore,
    browserSessionStore,
    consentStore,
    userStore,
    upstreamLoginStore,
    clientAssertionJtiStore,
  };
}

/** 現在の時刻をエポック秒（整数）で返す。 */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * サブジェクトとクライアントごとの集合を返す。
 *
 * `map` で `subject`、`clientId` の順にたどった `Set` を返す。
 * 途中の `Map` や `Set` がなければ、空のものを作って `map` に入れる。
 */
function entryOf(
  map: Map<string, Map<string, Set<string>>>,
  subject: string,
  clientId: string,
): Set<string> {
  let byClient = map.get(subject);
  if (!byClient) {
    byClient = new Map();
    map.set(subject, byClient);
  }
  let values = byClient.get(clientId);
  if (!values) {
    values = new Set();
    byClient.set(clientId, values);
  }
  return values;
}
