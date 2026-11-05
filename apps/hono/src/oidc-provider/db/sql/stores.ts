/**
 * ProviderStores (store.ts) on the tables of schema.sql: the stores the OP
 * uses when no other storage is passed in. Every SQL statement runs through
 * the SqlDatabase that createDatabase() (db/instance.ts) returns. An
 * operation that touches two tables (a transaction and its request, a code
 * and the status of its transaction) runs its statements one after another.
 *
 * Rewriting this file for another driver or an ORM is fine, but keep these
 * behaviors - the endpoints and resolvers.ts rely on them:
 *
 * 1. Keep the ProviderStores types (method names, parameters, return values).
 * 2. authCodeStore.consume and refreshTokenStore.consume flip is_used from
 *    FALSE to TRUE in ONE conditional UPDATE, and throw TokenError
 *    (invalid_grant) when it changed no row. A SELECT followed by an UPDATE
 *    lets two concurrent requests both see an unused code and both receive
 *    tokens (OAuth 2.1 §4.1.2).
 * 3. consume never deletes the row. A used code or a rotated refresh token has
 *    to stay readable, so a replay is detected and the grant's tokens revoked.
 * 4. get never returns an expired row, and does return used ones.
 * 5. revokeByGrantId also removes the rotated (used) refresh tokens of the grant.
 * 6. hasConsent is true only when every requested scope was granted.
 * 7. Codes and tokens are stored and looked up by their SHA-256 hash; the raw
 *    value is never written to the database.
 * 8. transactionStore.get returns a transaction only while it is in progress
 *    (requested, upstream_pending, authenticated), and delete ends it instead
 *    of removing the row: its status becomes failed, then code_issued if a code
 *    is issued from it, and token_issued once that code is exchanged, or once
 *    recordTokenIssued records the tokens the Implicit Flow returns from the
 *    authorization endpoint.
 */
import {
  TokenError,
  TokenErrorCode,
  type AccessTokenInfo,
  type AuthTransaction,
  type AuthorizationCodeData,
  type AuthorizationCodeInfo,
  type ClaimsParameter,
  type RefreshTokenInfo,
  type UserClaims,
} from '@maronn-openid-connect/core';
import type {
  AccessTokenStorage,
  AuthSessionInfo,
  AuthSessionStorage,
  AuthorizationCodeStorage,
  BrowserSessionStorage,
  ConsentStorage,
  ProviderStores,
  RefreshTokenStorage,
  TransactionStorage,
  UpstreamLoginStorage,
  ClientAssertionJtiStorage,
  UserStorage,
} from '../../store.js';
import type { SqlDatabase } from './database.js';
import { verifyPassword } from './users.js';

/** core prefixes the id of every AuthTransactionStore key with this. */
const TRANSACTION_KEY_PREFIX = 'auth_txn:';

/** The statuses of a transaction in progress. */
const IN_PROGRESS = "('requested', 'upstream_pending', 'authenticated')";

/**
 * SQL のテーブルに読み書きする OP のストアを返す。
 *
 * 返すのは、トランザクション、認可コード、アクセストークン、リフレッシュトークン、ログインの結果、ブラウザのセッション、同意、ユーザー、外部の ID プロバイダでのログイン、使用済みのクライアントアサーションの `jti` のストアである。
 * テーブルは `schema.sql` で定義したもので、SQL 文はすべて `db` で実行する。
 * 認可コードとトークンは、値そのものではなく SHA-256 のハッシュ（`hashKey()`）で保存し、そのハッシュで探す。
 *
 * 返したストアの `authCodeStore.consume()` と `refreshTokenStore.consume()` は、`is_used` を `FALSE` から `TRUE` に変える一つの条件付きの `UPDATE` を実行し、変わった行がなければ `TokenError`（`invalid_grant`）を投げる。
 * 同時に届いた二つのリクエストのうち、行を変えられた一方だけがトークンを受け取る（OAuth 2.1 §4.1.2）。
 */
export function createProviderStores(db: SqlDatabase): ProviderStores {
  // 認可リクエストの内容は `authentication_requests` に、フローの状態は `transactions` に保存する。
  const transactionStore: TransactionStorage = {
    async get(key) {
      const [row] = await db.all<TransactionRow>({
        sql:
          'SELECT t.created_at, t.expired_at, t.payload AS transaction_payload, r.client_id, ' +
          'r.redirect_uri, r.state, r.nonce, r.code_challenge, r.code_challenge_method, ' +
          'r.response_type, r.scope, r.response_mode, r.prompt, r.max_age, r.ui_locales, ' +
          'r.claims_locales, r.id_token_hint, r.login_hint, r.acr_values, r.claims, ' +
          'r.payload AS request_payload FROM transactions t ' +
          'JOIN authentication_requests r ON r.transaction_id = t.transaction_id ' +
          'WHERE t.transaction_id = ? AND t.status IN ' + IN_PROGRESS + ' AND t.expired_at > ?',
        params: [withoutPrefix(key, TRANSACTION_KEY_PREFIX), nowSeconds()],
      });
      if (!row) return null;
      const transaction: StoredTransaction = {
        ...(JSON.parse(row.request_payload) as OtherRequestParameters),
        ...(JSON.parse(row.transaction_payload) as TransactionPayload),
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        responseType: row.response_type,
        scope: row.scope ?? '',
        createdAt: Number(row.created_at) * 1000,
        expiresAt: Number(row.expired_at) * 1000,
      };
      if (row.state !== null) transaction.state = row.state;
      if (row.nonce !== null) transaction.nonce = row.nonce;
      if (row.code_challenge !== null) transaction.codeChallenge = row.code_challenge;
      if (row.code_challenge_method !== null) {
        transaction.codeChallengeMethod = row.code_challenge_method as 'S256';
      }
      if (row.response_mode !== null) transaction.responseMode = row.response_mode;
      if (row.prompt !== null) transaction.prompt = row.prompt;
      if (row.max_age !== null) transaction.maxAge = Number(row.max_age);
      if (row.ui_locales !== null) transaction.uiLocales = row.ui_locales;
      if (row.claims_locales !== null) transaction.claimsLocales = row.claims_locales;
      if (row.id_token_hint !== null) transaction.idTokenHint = row.id_token_hint;
      if (row.login_hint !== null) transaction.loginHint = row.login_hint;
      if (row.acr_values !== null) transaction.acrValues = row.acr_values;
      if (row.claims !== null) transaction.claims = JSON.parse(row.claims) as ClaimsParameter;
      return transaction;
    },
    // 有効期限には、トランザクション自身の `expiresAt`（ミリ秒）を秒に切り上げて使う。
    // core が渡す `ttlSeconds` も、この `expiresAt` から計算した値である。
    async put(key, value, _ttlSeconds) {
      const transactionId = withoutPrefix(key, TRANSACTION_KEY_PREFIX);
      const {
        clientId,
        redirectUri,
        state,
        nonce,
        codeChallenge,
        codeChallengeMethod,
        responseType,
        scope,
        responseMode,
        prompt,
        maxAge,
        uiLocales,
        claimsLocales,
        idTokenHint,
        loginHint,
        acrValues,
        claims,
        createdAt,
        expiresAt,
        csrfToken,
        failedAttempts,
        bindingHash,
        ...otherParameters
      } = value as StoredTransaction;
      // 新しいトランザクションは `requested` の状態で始める。
      // 保存し直すとき（ログインに失敗したときなど）は、今の状態を変えない。
      await db.run({
        sql:
          'INSERT INTO transactions (transaction_id, status, created_at, expired_at, payload) ' +
          "VALUES (?, 'requested', ?, ?, ?) " +
          'ON CONFLICT (transaction_id) DO UPDATE SET expired_at = excluded.expired_at, payload = excluded.payload',
        params: [
          transactionId,
          Math.floor(createdAt / 1000),
          Math.ceil(expiresAt / 1000),
          JSON.stringify({ csrfToken, failedAttempts, bindingHash }),
        ],
      });
      await db.run({
        sql:
          'INSERT INTO authentication_requests (transaction_id, client_id, redirect_uri, state, nonce, ' +
          'code_challenge, code_challenge_method, response_type, scope, response_mode, prompt, max_age, ' +
          'ui_locales, claims_locales, id_token_hint, login_hint, acr_values, claims, payload) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT (transaction_id) DO UPDATE SET client_id = excluded.client_id, ' +
          'redirect_uri = excluded.redirect_uri, state = excluded.state, nonce = excluded.nonce, ' +
          'code_challenge = excluded.code_challenge, code_challenge_method = excluded.code_challenge_method, ' +
          'response_type = excluded.response_type, scope = excluded.scope, ' +
          'response_mode = excluded.response_mode, prompt = excluded.prompt, max_age = excluded.max_age, ' +
          'ui_locales = excluded.ui_locales, claims_locales = excluded.claims_locales, ' +
          'id_token_hint = excluded.id_token_hint, login_hint = excluded.login_hint, ' +
          'acr_values = excluded.acr_values, claims = excluded.claims, payload = excluded.payload',
        params: [
          transactionId,
          clientId,
          redirectUri,
          state ?? null,
          nonce ?? null,
          codeChallenge ?? null,
          codeChallengeMethod ?? null,
          responseType,
          scope,
          responseMode ?? null,
          prompt ?? null,
          maxAge ?? null,
          uiLocales ?? null,
          claimsLocales ?? null,
          idTokenHint ?? null,
          loginHint ?? null,
          acrValues ?? null,
          claims === undefined ? null : JSON.stringify(claims),
          JSON.stringify(otherParameters),
        ],
      });
    },
    // トランザクションは一度しか使えないので、進行中なら状態を `failed` にして終わらせる。
    // 行は消さずに残す。
    async delete(key) {
      await db.run({
        sql: "UPDATE transactions SET status = 'failed' WHERE transaction_id = ? AND status IN " + IN_PROGRESS,
        params: [withoutPrefix(key, TRANSACTION_KEY_PREFIX)],
      });
    },
    // インプリシットフローがトランザクションを終わらせて（`delete`）からトークンを発行したので、状態を `token_issued` にする。
    async recordTokenIssued(transactionId) {
      await db.run({
        sql: "UPDATE transactions SET status = 'token_issued' WHERE transaction_id = ?",
        params: [transactionId],
      });
    },
  };

  const authCodeStore: AuthorizationCodeStorage = {
    async set(code, info) {
      // ルートが渡すのは core の `AuthorizationCodeData` で、認可コードを発行したトランザクションの ID（`transactionId`）を含む。
      // 認可コードの値そのものと、専用の列がある値は、`payload` に入れない。
      const { code: _code, used, expiresAt, grantId, transactionId, ...payload } =
        info as AuthorizationCodeInfo & Pick<AuthorizationCodeData, 'transactionId'>;
      await db.run({
        sql:
          'INSERT INTO codes (id, transaction_id, expired_at, is_used, grant_id, payload) ' +
          'VALUES (?, ?, ?, ' + sqlBoolean(used) + ', ?, ?)',
        params: [await hashKey(code), transactionId ?? null, expiresAt, grantId, JSON.stringify(payload)],
      });
      if (transactionId !== undefined) {
        await db.run({
          sql: "UPDATE transactions SET status = 'code_issued' WHERE transaction_id = ?",
          params: [transactionId],
        });
      }
    },
    async get(code) {
      const [row] = await db.all<CodeRow>({
        sql: 'SELECT expired_at, is_used, grant_id, payload FROM codes WHERE id = ? AND expired_at > ?',
        params: [await hashKey(code), nowSeconds()],
      });
      if (!row) return undefined;
      const payload = JSON.parse(row.payload) as Omit<
        AuthorizationCodeInfo,
        'code' | 'used' | 'expiresAt' | 'grantId'
      >;
      return {
        ...payload,
        code,
        grantId: row.grant_id,
        expiresAt: Number(row.expired_at),
        used: toBoolean(row.is_used),
      };
    },
    // 同時に届いた二つのリクエストのうち、行を変えられるのは一方だけである。
    // もう一方には `TokenError`（`invalid_grant`）を投げるので、そのリクエストはトークンを受け取れない。
    async consume(code) {
      const { changes } = await db.run({
        sql: 'UPDATE codes SET is_used = TRUE WHERE id = ? AND is_used = FALSE',
        params: [await hashKey(code)],
      });
      if (changes === 0) {
        throw new TokenError(TokenErrorCode.InvalidGrant, 'Authorization code has already been used');
      }
    },
    async delete(code) {
      await db.run({ sql: 'DELETE FROM codes WHERE id = ?', params: [await hashKey(code)] });
    },
  };

  const deleteAccessToken = async (token: string): Promise<void> => {
    await db.run({
      sql: 'DELETE FROM access_tokens WHERE token_hash = ?',
      params: [await hashKey(token)],
    });
  };

  const accessTokenStore: AccessTokenStorage = {
    async set(token, info) {
      const { sub, scope, clientId, expiresAt, iat, issuer, jti, grantId, acr, transactionId, ...payload } = info;
      const tokenHash = await hashKey(token);
      await db.run({
        sql:
          'INSERT INTO access_tokens (id, sub, exp, iat, iss, client_id, scope, acr, transaction_id, ' +
          'token_hash, grant_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ' +
          // トークンを発行したトランザクションとして、インプリシットフローが示すトランザクションか、グラントの元になった認可コードのトランザクションを記録する。
          // どちらもないグラント（デバイスフロー、CIBA）には記録しない。
          'COALESCE(?, (SELECT transaction_id FROM codes WHERE grant_id = ? LIMIT 1)), ?, ?, ?)',
        params: [
          // `jti` なしで発行されたトークンは、トークンのハッシュを `id` にする。
          jti ?? tokenHash,
          sub,
          expiresAt,
          iat ?? null,
          issuer ?? null,
          clientId,
          joinScope(scope),
          acr ?? null,
          transactionId ?? null,
          grantId ?? null,
          tokenHash,
          grantId ?? null,
          JSON.stringify(payload),
        ],
      });
      if (grantId !== undefined) {
        await db.run({
          sql:
            "UPDATE transactions SET status = 'token_issued' WHERE status = 'code_issued' " +
            'AND transaction_id = (SELECT transaction_id FROM codes WHERE grant_id = ? LIMIT 1)',
          params: [grantId],
        });
      }
    },
    async get(token) {
      const tokenHash = await hashKey(token);
      const [row] = await db.all<AccessTokenRow>({
        sql:
          'SELECT id, sub, exp, iat, iss, client_id, scope, acr, grant_id, payload FROM access_tokens ' +
          'WHERE token_hash = ? AND exp > ?',
        params: [tokenHash, nowSeconds()],
      });
      if (!row) return undefined;
      const info: AccessTokenInfo = {
        ...(JSON.parse(row.payload) as Omit<AccessTokenInfo, AccessTokenColumn>),
        sub: row.sub,
        clientId: row.client_id,
        scope: splitScope(row.scope),
        expiresAt: Number(row.exp),
      };
      if (row.id !== tokenHash) info.jti = row.id;
      if (row.iat !== null) info.iat = Number(row.iat);
      if (row.iss !== null) info.issuer = row.iss;
      if (row.acr !== null) info.acr = row.acr;
      if (row.grant_id !== null) info.grantId = row.grant_id;
      return info;
    },
    delete: deleteAccessToken,
    revoke: deleteAccessToken,
    async revokeByGrantId(grantId) {
      await db.run({ sql: 'DELETE FROM access_tokens WHERE grant_id = ?', params: [grantId] });
    },
  };

  const deleteRefreshToken = async (token: string): Promise<void> => {
    await db.run({ sql: 'DELETE FROM refresh_tokens WHERE id = ?', params: [await hashKey(token)] });
  };

  const refreshTokenStore: RefreshTokenStorage = {
    async set(token, info) {
      const { used, expiresAt, iat, grantId, ...payload } = info;
      await db.run({
        sql:
          'INSERT INTO refresh_tokens (id, access_token_id, exp, iat, is_used, grant_id, payload) VALUES (?, ' +
          // 同じトークンレスポンスのアクセストークンを `access_token_id` に記録する。
          // トークンエンドポイントはそのアクセストークンを直前に保存するので、同じグラントと `iat` を持ち、まだどのリフレッシュトークンにも結び付いていないアクセストークンを選ぶ。
          '(SELECT a.id FROM access_tokens a WHERE a.grant_id = ? AND a.iat = ? ' +
          'AND NOT EXISTS (SELECT 1 FROM refresh_tokens r WHERE r.access_token_id = a.id) ' +
          'ORDER BY a.id LIMIT 1), ?, ?, ' + sqlBoolean(used) + ', ?, ?)',
        params: [
          await hashKey(token),
          grantId,
          iat ?? null,
          expiresAt,
          iat ?? null,
          grantId,
          JSON.stringify(payload),
        ],
      });
    },
    async get(token) {
      const [row] = await db.all<RefreshTokenRow>({
        sql: 'SELECT exp, iat, is_used, grant_id, payload FROM refresh_tokens WHERE id = ? AND exp > ?',
        params: [await hashKey(token), nowSeconds()],
      });
      if (!row) return undefined;
      const info: RefreshTokenInfo = {
        ...(JSON.parse(row.payload) as Omit<RefreshTokenInfo, 'used' | 'expiresAt' | 'iat' | 'grantId'>),
        grantId: row.grant_id,
        expiresAt: Number(row.exp),
        used: toBoolean(row.is_used),
      };
      if (row.iat !== null) info.iat = Number(row.iat);
      return info;
    },
    // ローテーションのために、リフレッシュトークンを使用済みにする。
    // `authCodeStore.consume()` と同じく、同時に届いたリクエストのうち一つだけが成功する。
    async consume(token) {
      const { changes } = await db.run({
        sql: 'UPDATE refresh_tokens SET is_used = TRUE WHERE id = ? AND is_used = FALSE',
        params: [await hashKey(token)],
      });
      if (changes === 0) {
        throw new TokenError(TokenErrorCode.InvalidGrant, 'Refresh token has already been used');
      }
    },
    delete: deleteRefreshToken,
    revoke: deleteRefreshToken,
    // ローテーションで使用済みになったリフレッシュトークンも同じ `grant_id` を持つので、一緒に消える。
    async revokeByGrantId(grantId) {
      await db.run({ sql: 'DELETE FROM refresh_tokens WHERE grant_id = ?', params: [grantId] });
    },
  };

  // ログイン（`auth_users`）の `auth_type` として、ユーザーの外部アカウントの ID プロバイダ名を返し、外部アカウントがなければ `password` を返す。
  // 外部の ID プロバイダでのログイン（Google でのログインなど）で作られたユーザーにはパスワードがなく、`registerUser()`（`users.ts`）は外部アカウントを紐付けない。
  // そのため、パスワードのあるユーザーに利用者が外部アカウントを紐付けない限り、ユーザーのログインの方法は一つに決まる。
  const authTypeOf = async (userId: string): Promise<string> => {
    const [row] = await db.all<{ provider: string }>({
      sql: 'SELECT provider FROM federated_identities WHERE user_id = ? ORDER BY created_at LIMIT 1',
      params: [userId],
    });
    return row?.provider ?? 'password';
  };

  // ログインの結果（`auth_users`）は、`/login` から `/consent` へトランザクションごとに渡す。
  const authSessionStore: AuthSessionStorage = {
    async set(transactionId, info) {
      await db.run({
        sql:
          'INSERT INTO auth_users (transaction_id, user_id, auth_type, auth_time, session_id) ' +
          'VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT (transaction_id) DO UPDATE SET user_id = excluded.user_id, ' +
          'auth_type = excluded.auth_type, auth_time = excluded.auth_time, session_id = excluded.session_id',
        params: [transactionId, info.subject, await authTypeOf(info.subject), info.authTime, info.sessionId ?? null],
      });
      await db.run({
        sql:
          "UPDATE transactions SET status = 'authenticated' " +
          "WHERE transaction_id = ? AND status IN ('requested', 'upstream_pending')",
        params: [transactionId],
      });
    },
    async get(transactionId) {
      const [row] = await db.all<{ user_id: string; auth_time: number | string; session_id: string | null }>({
        sql: 'SELECT user_id, auth_time, session_id FROM auth_users WHERE transaction_id = ?',
        params: [transactionId],
      });
      if (!row) return undefined;
      const info: AuthSessionInfo = { subject: row.user_id, authTime: Number(row.auth_time) };
      if (row.session_id !== null) info.sessionId = row.session_id;
      return info;
    },
    async delete(transactionId) {
      await db.run({ sql: 'DELETE FROM auth_users WHERE transaction_id = ?', params: [transactionId] });
    },
  };

  const browserSessionStore: BrowserSessionStorage = {
    async set(sessionId, info) {
      await db.run({
        sql:
          'INSERT INTO browser_sessions (session_id, subject, auth_time) VALUES (?, ?, ?) ' +
          'ON CONFLICT (session_id) DO UPDATE SET subject = excluded.subject, auth_time = excluded.auth_time',
        params: [sessionId, info.subject, info.authTime],
      });
    },
    async get(sessionId) {
      const [row] = await db.all<{ subject: string; auth_time: number | string }>({
        sql: 'SELECT subject, auth_time FROM browser_sessions WHERE session_id = ?',
        params: [sessionId],
      });
      return row ? { subject: row.subject, authTime: Number(row.auth_time) } : undefined;
    },
    async delete(sessionId) {
      await db.run({ sql: 'DELETE FROM browser_sessions WHERE session_id = ?', params: [sessionId] });
    },
  };

  const consentStore: ConsentStorage = {
    async grant(subject, clientId, scopes) {
      const unique = [...new Set(scopes)];
      if (unique.length === 0) return;
      // 同意済みのスコープは `ON CONFLICT DO NOTHING` で飛ばし、新しいスコープだけを追加する。
      await db.run({
        sql:
          'INSERT INTO consent_scopes (subject, client_id, scope) VALUES ' +
          unique.map(() => '(?, ?, ?)').join(', ') +
          ' ON CONFLICT DO NOTHING',
        params: unique.flatMap((scope) => [subject, clientId, scope]),
      });
    },
    async hasConsent(subject, clientId, scopes) {
      const unique = [...new Set(scopes)];
      // スコープが一つもないリクエストは、同意済みとみなさず `false` を返す（空の `IN ()` は SQL として正しくない）。
      if (unique.length === 0) return false;
      const [row] = await db.all<{ granted: number | string }>({
        sql:
          'SELECT COUNT(*) AS granted FROM consent_scopes ' +
          'WHERE subject = ? AND client_id = ? AND scope IN (' +
          unique.map(() => '?').join(', ') +
          ')',
        params: [subject, clientId, ...unique],
      });
      // 一部のスコープにしか同意していなければ、数えた行は要求したスコープの数より少ない。
      return Number(row?.granted ?? 0) === unique.length;
    },
    async recordGrant(subject, clientId, grantId) {
      await db.run({
        sql:
          'INSERT INTO consent_grants (subject, client_id, grant_id) VALUES (?, ?, ?) ' +
          'ON CONFLICT DO NOTHING',
        params: [subject, clientId, grantId],
      });
    },
    async revoke(subject, clientId) {
      await db.run({
        sql: 'DELETE FROM consent_scopes WHERE subject = ? AND client_id = ?',
        params: [subject, clientId],
      });
      // `DELETE ... RETURNING` で、消したグラントを同じ文で受け取って返す。
      // 呼び出し側は、返されたグラントごとにトークンを失効させる。
      const rows = await db.all<{ grant_id: string }>({
        sql: 'DELETE FROM consent_grants WHERE subject = ? AND client_id = ? RETURNING grant_id',
        params: [subject, clientId],
      });
      return rows.map((row) => row.grant_id);
    },
  };


  // 外部の ID プロバイダのアカウントに紐付いたユーザーの ID を返し、紐付けがなければ `undefined` を返す。
  const findFederatedUser = async (provider: string, providerSub: string): Promise<string | undefined> => {
    const [row] = await db.all<{ user_id: string }>({
      sql: 'SELECT user_id FROM federated_identities WHERE provider = ? AND provider_sub = ?',
      params: [provider, providerSub],
    });
    return row?.user_id;
  };

  // 外部アカウントの最初のログインで、新しいランダムな ID のユーザーを作ってアカウントを紐付け、紐付いたユーザーの ID を返す。
  // 同じアカウントの最初のログインが同時に二つ届いても、`UNIQUE (provider, provider_sub)` によって紐付けは一つだけ残る。
  // 紐付けを書けなかったリクエストは、自分が作ったユーザーを消し、先に紐付いたユーザーの ID を返す。
  const createFederatedUser = async (provider: string, providerSub: string): Promise<string> => {
    const userId = crypto.randomUUID();
    const now = nowSeconds();
    await db.run({
      sql: 'INSERT INTO users (id, is_verified, created_at, updated_at) VALUES (?, FALSE, ?, ?)',
      params: [userId, now, now],
    });
    await db.run({
      sql:
        'INSERT INTO federated_identities (id, user_id, provider, provider_sub, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (provider, provider_sub) DO NOTHING',
      params: [crypto.randomUUID(), userId, provider, providerSub, now, now],
    });
    const linkedUserId = (await findFederatedUser(provider, providerSub)) ?? userId;
    if (linkedUserId !== userId) {
      await db.run({ sql: 'DELETE FROM users WHERE id = ?', params: [userId] });
    }
    return linkedUserId;
  };

  // 外部の ID プロバイダから受け取ったクレームを、ユーザーの行に保存する。
  // `email` と `email_verified` はそれぞれの列に、ほかのクレームは JSON にして `claims` に入れる。
  // `password_hash` は変えない。
  const saveFederatedClaims = async (claims: UserClaims): Promise<void> => {
    const { sub, email, email_verified, ...otherClaims } = claims;
    await db.run({
      sql:
        'UPDATE users SET email = ?, is_verified = ' + sqlBoolean(email_verified === true) + ', ' +
        'updated_at = ?, claims = ? WHERE id = ?',
      params: [email ?? null, nowSeconds(), JSON.stringify(otherClaims), sub],
    });
  };

  // ユーザーは `users` テーブルから読み書きする。
  // ユーザーは `registerUser()`（`users.ts`）で登録する。
  const userStore: UserStorage = {
    // パスワードのフォームでは、`users.id` をユーザー名として照合する。
    // メールアドレスでログインさせるには、代わりに `email` で行を探す。
    async authenticate(username, password) {
      const [row] = await db.all<UserRow & { password_hash: string | null }>({
        sql: 'SELECT email, is_verified, password_hash, claims FROM users WHERE id = ?',
        params: [username],
      });
      // `verifyPassword()` はハッシュがなくても同じだけ時間をかけるので、応答までの時間からユーザーの有無はわからない。
      // パスワードのないユーザー（外部の ID プロバイダでのログインで作られたユーザー）は、フォームではログインできない。
      const passwordHash = row?.password_hash ?? null;
      if (!(await verifyPassword(password, passwordHash)) || !row || passwordHash === null) {
        return undefined;
      }
      return { ...userClaims(username, row), password: passwordHash };
    },
    async getClaims(sub) {
      const [row] = await db.all<UserRow>({
        sql: 'SELECT email, is_verified, claims FROM users WHERE id = ?',
        params: [sub],
      });
      return row ? userClaims(sub, row) : undefined;
    },
    // 検証済みの外部アカウントのユーザーを紐付けから探し、なければ作る（メールアドレスでは探さない）。
    // そのうえで、外部の ID プロバイダから受け取ったクレームを保存して返す。
    async linkFederatedIdentity(identity) {
      const userId =
        (await findFederatedUser(identity.provider, identity.subject)) ??
        (await createFederatedUser(identity.provider, identity.subject));
      const claims: UserClaims = { ...identity.claims, sub: userId };
      await saveFederatedClaims(claims);
      return claims;
    },
  };

  // トランザクションが待っている外部の ID プロバイダでのログインは、トランザクションの `upstream_auth_requests` の行に保存し、`nonce` で探す。
  // 行はトランザクションに一つなので、新しいログイン画面の `nonce` が古い画面の `nonce` を置き換える。
  // `find()` はトランザクションの有効期限で絞るので、トランザクションが期限切れになると行は見つからなくなる。
  const upstreamLoginStore: UpstreamLoginStorage = {
    async find(nonce) {
      const [row] = await db.all<{ provider: string; transaction_id: string; expired_at: number | string }>({
        sql:
          'SELECT u.provider, u.transaction_id, t.expired_at FROM upstream_auth_requests u ' +
          'JOIN transactions t ON t.transaction_id = u.transaction_id ' +
          'WHERE u.nonce = ? AND t.expired_at > ?',
        params: [nonce, nowSeconds()],
      });
      if (!row) return undefined;
      return { provider: row.provider, transactionId: row.transaction_id, expiresAt: Number(row.expired_at) * 1000 };
    },
    async save(nonce, login) {
      await db.run({
        sql:
          'INSERT INTO upstream_auth_requests (transaction_id, provider, nonce) VALUES (?, ?, ?) ' +
          'ON CONFLICT (transaction_id) DO UPDATE SET provider = excluded.provider, nonce = excluded.nonce',
        params: [login.transactionId, login.provider, nonce],
      });
      await db.run({
        sql: "UPDATE transactions SET status = 'upstream_pending' WHERE transaction_id = ? AND status = 'requested'",
        params: [login.transactionId],
      });
    },
    async delete(nonce) {
      await db.run({ sql: 'DELETE FROM upstream_auth_requests WHERE nonce = ?', params: [nonce] });
    },
  };

  // 使用済みの `jti` は、`client_id` と `jti` の組のキーのハッシュで `client_assertion_jtis` の行に覚える（RFC 7523 §3）。
  // 期限切れの同じキーの行を消してから、`ON CONFLICT DO NOTHING` で入れ、行を足せたときだけ初めての `jti` とする。
  // 一つの文で入れるので、同じキーの二つのリクエストのうち、行を足せるのは一方だけである。
  const clientAssertionJtiStore: ClientAssertionJtiStorage = {
    async consume(key, expiresAt) {
      const id = await hashKey(key);
      await db.run({
        sql: 'DELETE FROM client_assertion_jtis WHERE id = ? AND expired_at <= ?',
        params: [id, nowSeconds()],
      });
      const { changes } = await db.run({
        sql: 'INSERT INTO client_assertion_jtis (id, expired_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING',
        params: [id, expiresAt],
      });
      return changes > 0;
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

/**
 * A transaction as the authorization endpoint stores it: with the name of the
 * response mode it answers in, when that is not the query response
 * (ResponseModeTransaction of endpoints/authorize/response-mode.ts).
 */
type StoredTransaction = AuthTransaction & { responseMode?: string };

/** The values of an AuthTransaction kept in transactions.payload. */
type TransactionPayload = Pick<AuthTransaction, 'csrfToken' | 'failedAttempts' | 'bindingHash'>;

/** The values of an AuthTransaction kept in authentication_requests.payload. */
type OtherRequestParameters = Omit<
  StoredTransaction,
  | keyof TransactionPayload
  | 'clientId'
  | 'redirectUri'
  | 'state'
  | 'nonce'
  | 'codeChallenge'
  | 'codeChallengeMethod'
  | 'responseType'
  | 'scope'
  | 'responseMode'
  | 'prompt'
  | 'maxAge'
  | 'uiLocales'
  | 'claimsLocales'
  | 'idTokenHint'
  | 'loginHint'
  | 'acrValues'
  | 'claims'
  | 'createdAt'
  | 'expiresAt'
>;

/** The values of an AccessTokenInfo with a column of their own in access_tokens. */
type AccessTokenColumn =
  | 'sub'
  | 'scope'
  | 'clientId'
  | 'expiresAt'
  | 'iat'
  | 'issuer'
  | 'jti'
  | 'grantId'
  | 'acr';

// Rows as the drivers return them: a BIGINT may come back as a string (pg) and
// a BOOLEAN as 1 / 0 (SQLite), so they are read with Number() and toBoolean().

interface TransactionRow {
  created_at: number | string;
  expired_at: number | string;
  transaction_payload: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  nonce: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  response_type: string;
  scope: string | null;
  response_mode: string | null;
  prompt: string | null;
  max_age: number | string | null;
  ui_locales: string | null;
  claims_locales: string | null;
  id_token_hint: string | null;
  login_hint: string | null;
  acr_values: string | null;
  claims: string | null;
  request_payload: string;
}

interface CodeRow {
  expired_at: number | string;
  is_used: unknown;
  grant_id: string;
  payload: string;
}

interface AccessTokenRow {
  id: string;
  sub: string;
  exp: number | string;
  iat: number | string | null;
  iss: string | null;
  client_id: string;
  scope: string | null;
  acr: string | null;
  grant_id: string | null;
  payload: string;
}

interface RefreshTokenRow {
  exp: number | string;
  iat: number | string | null;
  is_used: unknown;
  grant_id: string;
  payload: string;
}

interface UserRow {
  email: string | null;
  is_verified: unknown;
  claims: string | null;
}

/** 現在の時刻をエポック秒（整数）で返す。 */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * `users` の行からクレームを組み立てて返す。
 *
 * `sub` には引数の `sub` を使い、ほかのクレームは `claims` の列の JSON から取る。
 * 行に `email` があるときだけ、`email` と `email_verified`（`is_verified` の列）を加える。
 */
function userClaims(sub: string, row: UserRow): UserClaims {
  const claims: UserClaims = {
    ...(row.claims ? (JSON.parse(row.claims) as Partial<UserClaims>) : {}),
    sub,
  };
  if (row.email !== null) {
    claims.email = row.email;
    claims.email_verified = toBoolean(row.is_verified);
  }
  return claims;
}

/**
 * `key` の先頭の `prefix` を取り除いて返す。
 *
 * `prefix` で始まらない `key` は、そのまま返す。
 */
function withoutPrefix(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/**
 * スコープの配列を空白区切りの文字列にして返す。
 *
 * `access_tokens` の `scope` の列に保存する値で、スコープがなければ `null`（列では `NULL`）を返す。
 */
function joinScope(scope: string[]): string | null {
  return scope.length > 0 ? scope.join(' ') : null;
}

/**
 * 空白区切りのスコープを配列にして返す。
 *
 * `NULL` の列と空文字列には、空の配列を返す。
 */
function splitScope(scope: string | null): string[] {
  return scope ? scope.split(' ') : [];
}

/**
 * 真偽値を SQL の `TRUE` か `FALSE` で返す。
 *
 * `TRUE` と `FALSE` は、SQLite、D1、PostgreSQL のどれでも使える。
 * 数値をバインドすると、PostgreSQL のドライバによっては `BOOLEAN` として扱われないので、リテラルで書く。
 */
function sqlBoolean(value: boolean): 'TRUE' | 'FALSE' {
  return value ? 'TRUE' : 'FALSE';
}

/**
 * 読み出した `BOOLEAN` の列の値を真偽値にして返す。
 *
 * PostgreSQL は `true` か `false` を、SQLite は `1` か `0` を返すので、`true` と、数値にすると 1 になる値を真とみなす。
 */
function toBoolean(value: unknown): boolean {
  return value === true || Number(value) === 1;
}

/**
 * 値の SHA-256 ハッシュを base64url で返す。
 *
 * 認可コードとトークンは、この値で保存して探す。
 * パディングは付けない。
 */
async function hashKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
