/**
 * ProviderStores (store.ts) on the key-value store of db/instance.ts: the
 * stores the OP uses when no other storage is passed in. keys.ts lists the
 * keys and the records they hold.
 *
 * Rewriting this file for another store is fine, but keep these behaviors -
 * the endpoints and resolvers.ts rely on them:
 *
 * 1. Keep the ProviderStores types (method names, parameters, return values).
 * 2. authCodeStore.consume and refreshTokenStore.consume claim the code_used /
 *    refresh_token_used key with setIfAbsent, and throw TokenError
 *    (invalid_grant) when it was already taken. A get followed by a set lets
 *    two concurrent requests both see an unused code and both receive tokens
 *    (OAuth 2.1 §4.1.2).
 * 3. consume never deletes the record. A used code or a rotated refresh token
 *    has to stay readable, so a replay is detected and the grant's tokens
 *    revoked.
 * 4. get never returns an expired record, and does return used ones.
 * 5. revokeByGrantId makes every token of that kind in the grant unreadable,
 *    the rotated (used) refresh tokens included, by writing a marker key with
 *    set. Nothing the stores read and write back holds it, so a token request
 *    running at the same moment cannot undo it.
 * 6. hasConsent is true only when every requested scope was granted.
 * 7. Codes and tokens are stored under their SHA-256 hash; the raw value is
 *    never written to the store.
 * 8. transactionStore.get returns a transaction only while it is in progress,
 *    and delete ends it with a transaction_result key that put never changes,
 *    so an ended transaction cannot start again: failed, then code_issued if a
 *    code is issued from it, and token_issued once that code is exchanged, or
 *    once recordTokenIssued records the tokens the Implicit Flow returns from
 *    the authorization endpoint.
 *
 * A few records are read, changed and written back: a grant, a consent, and
 * the status of a transaction in progress. Two requests that change the same
 * one at the same moment can lose one of the changes. The OP's flows change a
 * grant from one request at a time (consume lets one refresh through). A
 * consent changes at once only when one user authorizes one client from two
 * browser tabs in the same moment: a lost scope asks the user again, and a
 * lost grant id leaves that grant out of revokeConsentAndTokens().
 */
import {
  TokenError,
  TokenErrorCode,
  type AccessTokenInfo,
  type AuthTransaction,
  type AuthorizationCodeData,
  type AuthorizationCodeInfo,
  type RefreshTokenInfo,
  type UserClaims,
} from '@maronn-openid-connect/core';
import {
  type AccessTokenStorage,
  type AuthSessionInfo,
  type AuthSessionStorage,
  type AuthorizationCodeStorage,
  type BrowserSessionStorage,
  type ConsentStorage,
  type ProviderStores,
  type RefreshTokenStorage,
  type TransactionStorage,
  type UpstreamLoginStorage,
  type UserStorage,
} from '../store';
import { readRecord, writeRecord, type KvDatabase } from './database';
import {
  keys,
  type AccessTokenRecord,
  type AuthUserRecord,
  type BrowserSessionRecord,
  type CodeRecord,
  type ConsentRecord,
  type FederatedIdentityRecord,
  type GrantRecord,
  type RefreshTokenRecord,
  type TransactionRecord,
  type TransactionResultRecord,
  type UpstreamAuthRequestRecord,
  type UpstreamNonceRecord,
  type UserRecord,
} from './keys';
import { verifyPassword } from './users';

/** core prefixes the id of every AuthTransactionStore key with this. */
const TRANSACTION_KEY_PREFIX = 'auth_txn:';

/**
 * The TTL of a sign-in (auth_user) whose transaction record is already gone:
 * the transaction cannot be completed any more, so the record only has to
 * outlive the request that writes it.
 */
const FALLBACK_TTL_SECONDS = 600;

/** The value of a single-use marker (code_used, refresh_token_used) and of a revocation marker. */
const MARKER = 'true';

/**
 * KV ストアに読み書きする OP のストアを返す。
 *
 * 返すのは、トランザクション、認可コード、アクセストークン、リフレッシュトークン、ログインの結果、ブラウザのセッション、同意、ユーザー、外部の ID プロバイダでのログインのストアである。
 * 一つのレコードを一つのキーに保存し、有効期限のあるデータのキーには、その有効期限までの有効期間を付ける。
 * 認可コードとトークンは、値そのものではなく SHA-256 のハッシュ（`hashKey()`）をキーにして保存する。
 *
 * 返したストアの `authCodeStore.consume()` と `refreshTokenStore.consume()` は、使用済みの目印のキーを `setIfAbsent` で書き、書けなければ（すでに使用済みか、レコードがなければ）`TokenError`（`invalid_grant`）を投げる。
 * 同時に届いた二つのリクエストのうち、目印を書けた一方だけがトークンを受け取る（OAuth 2.1 §4.1.2）。
 */
export function createProviderStores(db: KvDatabase): ProviderStores {
  const read = <T>(key: string) => readRecord<T>(db, key);
  const write = (key: string, record: unknown, ttlSeconds?: number) =>
    writeRecord(db, key, record, ttlSeconds);

  /** 期限切れでないトランザクションのレコードを返し、期限切れなら `undefined` を返す。 */
  const readTransaction = async (transactionId: string): Promise<TransactionRecord | undefined> => {
    const record = await read<TransactionRecord>(keys.transaction(transactionId));
    return record && record.expired_at > nowSeconds() ? record : undefined;
  };

  /** 進行中のトランザクションの状態が `from` のどれかなら、`status` に変えて書き戻す。 */
  const advanceTransaction = async (
    transactionId: string,
    from: Array<TransactionRecord['status']>,
    status: TransactionRecord['status'],
  ): Promise<void> => {
    const record = await readTransaction(transactionId);
    if (record && from.includes(record.status)) {
      await write(keys.transaction(transactionId), { ...record, status }, ttlUntil(record.expired_at));
    }
  };

  /**
   * グラントのレコードを `change` で変えて書き戻し、変えたレコードを返す。
   * レコードがなければ、空のグラントから始める。
   * レコードの有効期限は、元の有効期限と `expiresAt` の遅いほうにする。
   */
  const updateGrant = async (
    grantId: string,
    expiresAt: number,
    change: (grant: GrantRecord) => GrantRecord,
  ): Promise<GrantRecord> => {
    const current = (await read<GrantRecord>(keys.grant(grantId))) ?? {
      transaction_id: null,
      latest_access_token: null,
      expired_at: 0,
    };
    const grant = { ...change(current), expired_at: Math.max(current.expired_at, expiresAt) };
    await write(keys.grant(grantId), grant, ttlUntil(grant.expired_at));
    return grant;
  };

  /**
   * 目印のキー `revokedKey` を書いて、グラントの一つの種類のトークンを失効させる。
   * 目印は、グラントの最後の認可コードかトークンの有効期限まで残す。
   */
  const revokeGrant = async (revokedKey: string, grantId: string): Promise<void> => {
    const grant = await read<GrantRecord>(keys.grant(grantId));
    // グラントのレコードがなければ、グラントの認可コードとトークンはすべて期限切れなので、何も書かない。
    if (grant) await db.set(revokedKey, MARKER, ttlUntil(grant.expired_at));
  };

  // トランザクションとその認可リクエスト（`authentication_request`）は一つのレコードにまとめ、一度の `set` で書く。
  const transactionStore: TransactionStorage = {
    async get(key) {
      const transactionId = withoutPrefix(key, TRANSACTION_KEY_PREFIX);
      const [record, result] = await Promise.all([
        readTransaction(transactionId),
        db.get(keys.transactionResult(transactionId)),
      ]);
      // 終わったトランザクション（結果が `failed`、`code_issued`、`token_issued`）は、ないものとして `null` を返す。
      if (!record || result !== null) return null;
      const request = record.authentication_request;
      const transaction: StoredTransaction = {
        ...(request.payload as OtherRequestParameters),
        ...(record.payload as TransactionPayload),
        clientId: request.client_id,
        redirectUri: request.redirect_uri,
        responseType: request.response_type,
        scope: request.scope ?? '',
        createdAt: record.created_at * 1000,
        expiresAt: record.expired_at * 1000,
      };
      if (request.state !== null) transaction.state = request.state;
      if (request.nonce !== null) transaction.nonce = request.nonce;
      if (request.code_challenge !== null) transaction.codeChallenge = request.code_challenge;
      if (request.code_challenge_method !== null) {
        transaction.codeChallengeMethod = request.code_challenge_method as 'S256';
      }
      if (request.response_mode !== null) transaction.responseMode = request.response_mode;
      if (request.prompt !== null) transaction.prompt = request.prompt;
      if (request.max_age !== null) transaction.maxAge = request.max_age;
      if (request.ui_locales !== null) transaction.uiLocales = request.ui_locales;
      if (request.claims_locales !== null) transaction.claimsLocales = request.claims_locales;
      if (request.id_token_hint !== null) transaction.idTokenHint = request.id_token_hint;
      if (request.login_hint !== null) transaction.loginHint = request.login_hint;
      if (request.acr_values !== null) transaction.acrValues = request.acr_values;
      if (request.claims !== null) transaction.claims = request.claims;
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
      const current = await readTransaction(transactionId);
      const record: TransactionRecord = {
        status: current?.status ?? 'requested',
        created_at: Math.floor(createdAt / 1000),
        expired_at: Math.ceil(expiresAt / 1000),
        authentication_request: {
          client_id: clientId,
          redirect_uri: redirectUri,
          state: state ?? null,
          nonce: nonce ?? null,
          code_challenge: codeChallenge ?? null,
          code_challenge_method: codeChallengeMethod ?? null,
          response_type: responseType,
          scope,
          response_mode: responseMode ?? null,
          prompt: prompt ?? null,
          max_age: maxAge ?? null,
          ui_locales: uiLocales ?? null,
          claims_locales: claimsLocales ?? null,
          id_token_hint: idTokenHint ?? null,
          login_hint: loginHint ?? null,
          acr_values: acrValues ?? null,
          claims: claims ?? null,
          payload: otherParameters,
        },
        payload: { csrfToken, failedAttempts, bindingHash },
      };
      await write(keys.transaction(transactionId), record, ttlUntil(record.expired_at));
    },
    // トランザクションは一度しか使えないので、結果 `failed` を書いて終わらせる。
    // 結果は `setIfAbsent` で書くので、すでに認可コードを発行していれば結果は `code_issued` のまま変わらない。
    async delete(key) {
      const transactionId = withoutPrefix(key, TRANSACTION_KEY_PREFIX);
      const record = await readTransaction(transactionId);
      if (!record) return;
      const result: TransactionResultRecord = { status: 'failed' };
      await db.setIfAbsent(
        keys.transactionResult(transactionId),
        JSON.stringify(result),
        ttlUntil(record.expired_at),
      );
    },
    // インプリシットフローがトランザクションを終わらせて（`delete`）からトークンを発行したので、結果を `token_issued` にする。
    async recordTokenIssued(transactionId) {
      const record = await readTransaction(transactionId);
      if (!record) return;
      const result: TransactionResultRecord = { status: 'token_issued' };
      await db.set(keys.transactionResult(transactionId), JSON.stringify(result), ttlUntil(record.expired_at));
    },
  };

  const authCodeStore: AuthorizationCodeStorage = {
    async set(code, info) {
      // ルートが渡すのは core の `AuthorizationCodeData` で、認可コードを発行したトランザクションの ID（`transactionId`）を含む。
      // 認可コードの値そのものと、レコードに専用の項目がある値は、`payload` に入れない。
      const { code: _code, used, expiresAt, grantId, transactionId, ...payload } =
        info as AuthorizationCodeInfo & Pick<AuthorizationCodeData, 'transactionId'>;
      const codeHash = await hashKey(code);
      const record: CodeRecord = {
        transaction_id: transactionId ?? null,
        expired_at: expiresAt,
        grant_id: grantId,
        payload,
      };
      await write(keys.code(codeHash), record, ttlUntil(expiresAt));
      if (used) await db.setIfAbsent(keys.codeUsed(codeHash), MARKER, ttlUntil(expiresAt));
      await updateGrant(grantId, expiresAt, (grant) => ({
        ...grant,
        transaction_id: transactionId ?? grant.transaction_id,
      }));
      if (transactionId !== undefined) {
        // 結果のキーは、トランザクションが期限切れになっても認可コードの有効期限までは残す。
        // 認可コードを交換したときに、結果 `token_issued` を記録できるようにするためである。
        const transaction = await read<TransactionRecord>(keys.transaction(transactionId));
        const result: TransactionResultRecord = { status: 'code_issued' };
        await db.set(
          keys.transactionResult(transactionId),
          JSON.stringify(result),
          ttlUntil(Math.max(expiresAt, transaction?.expired_at ?? 0)),
        );
      }
    },
    async get(code) {
      const codeHash = await hashKey(code);
      const [record, used] = await Promise.all([
        read<CodeRecord>(keys.code(codeHash)),
        db.get(keys.codeUsed(codeHash)),
      ]);
      if (!record || record.expired_at <= nowSeconds()) return undefined;
      return {
        ...(record.payload as Omit<AuthorizationCodeInfo, 'code' | 'used' | 'expiresAt' | 'grantId'>),
        code,
        grantId: record.grant_id,
        expiresAt: record.expired_at,
        used: used !== null,
      };
    },
    // 同時に届いた二つのリクエストのうち、`code_used` のキーを書けるのは一方だけである。
    // もう一方には `TokenError`（`invalid_grant`）を投げるので、そのリクエストはトークンを受け取れない。
    async consume(code) {
      const codeHash = await hashKey(code);
      const record = await read<CodeRecord>(keys.code(codeHash));
      const claimed =
        record !== undefined &&
        (await db.setIfAbsent(keys.codeUsed(codeHash), MARKER, ttlUntil(record.expired_at)));
      if (!claimed) {
        throw new TokenError(TokenErrorCode.InvalidGrant, 'Authorization code has already been used');
      }
    },
    async delete(code) {
      const codeHash = await hashKey(code);
      await db.delete(keys.code(codeHash));
      await db.delete(keys.codeUsed(codeHash));
    },
  };

  const deleteAccessToken = async (token: string): Promise<void> => {
    await db.delete(keys.accessToken(await hashKey(token)));
  };

  const accessTokenStore: AccessTokenStorage = {
    async set(token, info) {
      const { sub, scope, clientId, expiresAt, iat, issuer, jti, grantId, acr, transactionId, ...payload } = info;
      const tokenHash = await hashKey(token);
      // `jti` なしで発行されたトークンは、トークンのハッシュをレコードの `id` にする。
      const id = jti ?? tokenHash;
      // グラントのレコードも、グラントの元になった認可コードのトランザクションを示す。
      // 認可コードのないグラントは、トランザクションを示さない。
      // インプリシットフローではトークン自身がトランザクションを示し、デバイスフローと CIBA にはトランザクションがない。
      const grant =
        grantId === undefined
          ? undefined
          : await updateGrant(grantId, expiresAt, (current) => ({
            ...current,
            latest_access_token: { id, iat: iat ?? null },
          }));
      const record: AccessTokenRecord = {
        id,
        sub,
        exp: expiresAt,
        iat: iat ?? null,
        iss: issuer ?? null,
        client_id: clientId,
        scope: joinScope(scope),
        acr: acr ?? null,
        transaction_id: transactionId ?? grant?.transaction_id ?? null,
        grant_id: grantId ?? null,
        payload,
      };
      await write(keys.accessToken(tokenHash), record, ttlUntil(expiresAt));
      if (grant?.transaction_id) {
        const transactionId = grant.transaction_id;
        const result = await read<TransactionResultRecord>(keys.transactionResult(transactionId));
        if (result?.status === 'code_issued') {
          const issued: TransactionResultRecord = { status: 'token_issued' };
          await db.set(keys.transactionResult(transactionId), JSON.stringify(issued), ttlUntil(expiresAt));
        }
      }
    },
    async get(token) {
      const tokenHash = await hashKey(token);
      const record = await read<AccessTokenRecord>(keys.accessToken(tokenHash));
      if (!record || record.exp <= nowSeconds()) return undefined;
      if (record.grant_id !== null && (await db.get(keys.grantAccessTokensRevoked(record.grant_id))) !== null) {
        return undefined;
      }
      const info: AccessTokenInfo = {
        ...(record.payload as Omit<AccessTokenInfo, AccessTokenField>),
        sub: record.sub,
        clientId: record.client_id,
        scope: splitScope(record.scope),
        expiresAt: record.exp,
      };
      if (record.id !== tokenHash) info.jti = record.id;
      if (record.iat !== null) info.iat = record.iat;
      if (record.iss !== null) info.issuer = record.iss;
      if (record.acr !== null) info.acr = record.acr;
      if (record.grant_id !== null) info.grantId = record.grant_id;
      return info;
    },
    delete: deleteAccessToken,
    revoke: deleteAccessToken,
    async revokeByGrantId(grantId) {
      await revokeGrant(keys.grantAccessTokensRevoked(grantId), grantId);
    },
  };

  const deleteRefreshToken = async (token: string): Promise<void> => {
    const tokenHash = await hashKey(token);
    await db.delete(keys.refreshToken(tokenHash));
    await db.delete(keys.refreshTokenUsed(tokenHash));
  };

  const refreshTokenStore: RefreshTokenStorage = {
    async set(token, info) {
      const { used, expiresAt, iat, grantId, ...payload } = info;
      const tokenHash = await hashKey(token);
      let accessTokenId: string | null = null;
      // 同じトークンレスポンスのアクセストークンの ID を、`access_token_id` に記録する。
      // トークンエンドポイントはそのアクセストークンを直前に保存するので、グラントに記録された最新のアクセストークンの `iat` が同じなら、それを使う。
      await updateGrant(grantId, expiresAt, (grant) => {
        const latest = grant.latest_access_token;
        if (latest && latest.iat === (iat ?? null)) accessTokenId = latest.id;
        return { ...grant, latest_access_token: null };
      });
      const record: RefreshTokenRecord = {
        access_token_id: accessTokenId,
        exp: expiresAt,
        iat: iat ?? null,
        grant_id: grantId,
        payload,
      };
      await write(keys.refreshToken(tokenHash), record, ttlUntil(expiresAt));
      if (used) await db.setIfAbsent(keys.refreshTokenUsed(tokenHash), MARKER, ttlUntil(expiresAt));
    },
    async get(token) {
      const tokenHash = await hashKey(token);
      const [record, used] = await Promise.all([
        read<RefreshTokenRecord>(keys.refreshToken(tokenHash)),
        db.get(keys.refreshTokenUsed(tokenHash)),
      ]);
      if (!record || record.exp <= nowSeconds()) return undefined;
      if ((await db.get(keys.grantRefreshTokensRevoked(record.grant_id))) !== null) return undefined;
      const info: RefreshTokenInfo = {
        ...(record.payload as Omit<RefreshTokenInfo, 'used' | 'expiresAt' | 'iat' | 'grantId'>),
        grantId: record.grant_id,
        expiresAt: record.exp,
        used: used !== null,
      };
      if (record.iat !== null) info.iat = record.iat;
      return info;
    },
    // ローテーションのために、リフレッシュトークンを使用済みにする。
    // `authCodeStore.consume()` と同じく、同時に届いたリクエストのうち一つだけが成功する。
    async consume(token) {
      const tokenHash = await hashKey(token);
      const record = await read<RefreshTokenRecord>(keys.refreshToken(tokenHash));
      const claimed =
        record !== undefined &&
        (await db.setIfAbsent(keys.refreshTokenUsed(tokenHash), MARKER, ttlUntil(record.exp)));
      if (!claimed) {
        throw new TokenError(TokenErrorCode.InvalidGrant, 'Refresh token has already been used');
      }
    },
    delete: deleteRefreshToken,
    revoke: deleteRefreshToken,
    async revokeByGrantId(grantId) {
      await revokeGrant(keys.grantRefreshTokensRevoked(grantId), grantId);
    },
  };

  // ログイン（`auth_user`）の `auth_type` として、ユーザーの外部アカウントの ID プロバイダ名を返し、外部アカウントがなければ `password` を返す。
  // 外部の ID プロバイダでのログイン（Google でのログインなど）で作られたユーザーにはパスワードがなく、`registerUser()`（`users.ts`）は外部アカウントを紐付けない。
  // そのため、パスワードのあるユーザーに利用者が外部アカウントを紐付けない限り、ユーザーのログインの方法は一つに決まる。
  const authTypeOf = async (userId: string): Promise<string> => {
    const user = await read<UserRecord>(keys.user(userId));
    return user?.federated_identities?.[0]?.provider ?? 'password';
  };

  // ログインの結果（`auth_user`）は、`/login` から `/consent` へトランザクションごとに渡す。
  // レコードはトランザクションと同時に期限切れになる。
  // トランザクションのレコードがすでになければ、有効期間を `FALLBACK_TTL_SECONDS` にする。
  const authSessionStore: AuthSessionStorage = {
    async set(transactionId, info) {
      const transaction = await readTransaction(transactionId);
      const record: AuthUserRecord = {
        user_id: info.subject,
        auth_type: await authTypeOf(info.subject),
        auth_time: info.authTime,
        session_id: info.sessionId ?? null,
      };
      await write(
        keys.authUser(transactionId),
        record,
        transaction ? ttlUntil(transaction.expired_at) : FALLBACK_TTL_SECONDS,
      );
      await advanceTransaction(transactionId, ['requested', 'upstream_pending'], 'authenticated');
    },
    async get(transactionId) {
      const record = await read<AuthUserRecord>(keys.authUser(transactionId));
      if (!record) return undefined;
      const info: AuthSessionInfo = { subject: record.user_id, authTime: record.auth_time };
      if (record.session_id !== null) info.sessionId = record.session_id;
      return info;
    },
    async delete(transactionId) {
      await db.delete(keys.authUser(transactionId));
    },
  };

  const browserSessionStore: BrowserSessionStorage = {
    async set(sessionId, info) {
      const record: BrowserSessionRecord = { subject: info.subject, auth_time: info.authTime };
      await write(keys.browserSession(sessionId), record);
    },
    async get(sessionId) {
      const record = await read<BrowserSessionRecord>(keys.browserSession(sessionId));
      return record ? { subject: record.subject, authTime: record.auth_time } : undefined;
    },
    async delete(sessionId) {
      await db.delete(keys.browserSession(sessionId));
    },
  };

  const readConsent = async (subject: string, clientId: string): Promise<ConsentRecord> =>
    (await read<ConsentRecord>(keys.consent(subject, clientId))) ?? { scopes: [], grant_ids: [] };

  const consentStore: ConsentStorage = {
    async grant(subject, clientId, scopes) {
      if (scopes.length === 0) return;
      const consent = await readConsent(subject, clientId);
      await write(keys.consent(subject, clientId), {
        ...consent,
        scopes: [...new Set([...consent.scopes, ...scopes])],
      });
    },
    async hasConsent(subject, clientId, scopes) {
      const unique = [...new Set(scopes)];
      // スコープが一つもないリクエストは、同意済みとみなさず `false` を返す。
      if (unique.length === 0) return false;
      const consent = await readConsent(subject, clientId);
      return unique.every((scope) => consent.scopes.includes(scope));
    },
    async recordGrant(subject, clientId, grantId) {
      const consent = await readConsent(subject, clientId);
      if (consent.grant_ids.includes(grantId)) return;
      await write(keys.consent(subject, clientId), {
        ...consent,
        grant_ids: [...consent.grant_ids, grantId],
      });
    },
    // 同意のレコードを消し、記録していたグラント ID を返す。
    // 呼び出し側は、返されたグラントごとにトークンを失効させる。
    async revoke(subject, clientId) {
      const consent = await readConsent(subject, clientId);
      await db.delete(keys.consent(subject, clientId));
      return consent.grant_ids;
    },
  };

  // 外部の ID プロバイダのアカウントに紐付いたユーザーの ID を返し、紐付けがなければ `undefined` を返す。
  const findFederatedUser = async (provider: string, providerSub: string): Promise<string | undefined> => {
    const identity = await read<FederatedIdentityRecord>(keys.federatedIdentity(provider, providerSub));
    return identity?.user_id;
  };

  // 外部アカウントの最初のログインで、アカウントを新しいランダムな ID のユーザーに紐付け、そのユーザーの ID を返す。
  // 同じアカウントの最初のログインが同時に二つ届くと、`setIfAbsent` で紐付けを書けるのは一方だけである。
  // 書けなかったリクエストは、先に書かれた紐付けのユーザーを使う。
  const createFederatedUser = async (provider: string, providerSub: string): Promise<string> => {
    const userId = crypto.randomUUID();
    const now = nowSeconds();
    const identity: FederatedIdentityRecord = { user_id: userId, created_at: now, updated_at: now };
    const linked = await db.setIfAbsent(
      keys.federatedIdentity(provider, providerSub),
      JSON.stringify(identity),
    );
    return linked ? userId : ((await findFederatedUser(provider, providerSub)) ?? userId);
  };

  // 外部の ID プロバイダから受け取ったクレームをユーザーのレコードに保存し、最初のログインならレコードを作る。
  // `email` と `email_verified` はそれぞれの項目に、ほかのクレームは `claims` に入れる。
  // `federated_identities` にこの外部アカウントがなければ加え、`password_hash` は変えない。
  const saveFederatedClaims = async (
    claims: UserClaims,
    provider: string,
    providerSub: string,
  ): Promise<void> => {
    const { sub, email, email_verified, ...otherClaims } = claims;
    const current = await read<UserRecord>(keys.user(sub));
    const now = nowSeconds();
    const identities = current?.federated_identities ?? [];
    const linked = identities.some(
      (identity) => identity.provider === provider && identity.provider_sub === providerSub,
    );
    const record: UserRecord = {
      email: email ?? null,
      is_verified: email_verified === true,
      password_hash: current?.password_hash ?? null,
      created_at: current?.created_at ?? now,
      updated_at: now,
      claims: otherClaims,
      federated_identities: linked
        ? identities
        : [...identities, { provider, provider_sub: providerSub }],
    };
    await write(keys.user(sub), record);
  };

  // ユーザーのレコードを読み書きする。
  // ユーザーは `registerUser()`（`users.ts`）で登録する。
  const userStore: UserStorage = {
    // パスワードのフォームでは、ユーザーの ID をユーザー名として照合する。
    async authenticate(username, password) {
      const user = await read<UserRecord>(keys.user(username));
      // `verifyPassword()` はハッシュがなくても同じだけ時間をかけるので、応答までの時間からユーザーの有無はわからない。
      // パスワードのないユーザーは、フォームではログインできない。
      const passwordHash = user?.password_hash ?? null;
      if (!(await verifyPassword(password, passwordHash)) || !user || passwordHash === null) {
        return undefined;
      }
      return { ...userClaims(username, user), password: passwordHash };
    },
    async getClaims(sub) {
      const user = await read<UserRecord>(keys.user(sub));
      return user ? userClaims(sub, user) : undefined;
    },
    // 検証済みの外部アカウントのユーザーを紐付けから探し、なければ作る（メールアドレスでは探さない）。
    // そのうえで、外部の ID プロバイダから受け取ったクレームを保存して返す。
    async linkFederatedIdentity(identity) {
      const userId =
        (await findFederatedUser(identity.provider, identity.subject)) ??
        (await createFederatedUser(identity.provider, identity.subject));
      const claims: UserClaims = { ...identity.claims, sub: userId };
      await saveFederatedClaims(claims, identity.provider, identity.subject);
      return claims;
    },
  };

  // トランザクションが待っている外部の ID プロバイダでのログインは、トランザクションの `upstream_auth_request` のレコードに保存し、`upstream_nonce` を通して `nonce` から探す。
  // レコードはトランザクションに一つなので、新しいログイン画面の `nonce` が古い画面の `nonce` を置き換える。
  // 二つのレコードは、トランザクションと同時に期限切れになる。
  const upstreamLoginStore: UpstreamLoginStorage = {
    async find(nonce) {
      const index = await read<UpstreamNonceRecord>(keys.upstreamNonce(nonce));
      if (!index) return undefined;
      const request = await read<UpstreamAuthRequestRecord>(keys.upstreamAuthRequest(index.transaction_id));
      if (!request || request.nonce !== nonce || request.expired_at <= nowSeconds()) return undefined;
      return { provider: request.provider, transactionId: index.transaction_id, expiresAt: request.expired_at * 1000 };
    },
    async save(nonce, login) {
      const expiredAt = Math.ceil(login.expiresAt / 1000);
      const ttlSeconds = Math.max(1, expiredAt - nowSeconds());
      const request: UpstreamAuthRequestRecord = {
        provider: login.provider,
        state: null,
        nonce,
        code_verifier: null,
        expired_at: expiredAt,
      };
      const index: UpstreamNonceRecord = { transaction_id: login.transactionId };
      await write(keys.upstreamAuthRequest(login.transactionId), request, ttlSeconds);
      await write(keys.upstreamNonce(nonce), index, ttlSeconds);
      await advanceTransaction(login.transactionId, ['requested'], 'upstream_pending');
    },
    async delete(nonce) {
      const index = await read<UpstreamNonceRecord>(keys.upstreamNonce(nonce));
      await db.delete(keys.upstreamNonce(nonce));
      if (!index) return;
      const request = await read<UpstreamAuthRequestRecord>(keys.upstreamAuthRequest(index.transaction_id));
      if (request?.nonce === nonce) await db.delete(keys.upstreamAuthRequest(index.transaction_id));
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
  };
}

/**
 * A transaction as the authorization endpoint stores it: with the name of the
 * response mode it answers in, when that is not the query response
 * (ResponseModeTransaction of endpoints/authorize/response-mode.ts).
 */
type StoredTransaction = AuthTransaction & { responseMode?: string };

/** The values of an AuthTransaction kept in the payload of the transaction record. */
type TransactionPayload = Pick<AuthTransaction, 'csrfToken' | 'failedAttempts' | 'bindingHash'>;

/** The values of an AuthTransaction kept in the payload of its authentication request. */
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

/** The values of an AccessTokenInfo with a field of their own in the access token record. */
type AccessTokenField =
  | 'sub'
  | 'scope'
  | 'clientId'
  | 'expiresAt'
  | 'iat'
  | 'issuer'
  | 'jti'
  | 'grantId'
  | 'acr';

/** 現在の時刻をエポック秒（整数）で返す。 */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * `expiresAt` までの有効期間を秒で返す。
 *
 * `expiresAt` はエポック秒で受け取る。
 * 期限が過ぎていても 1 を返す（KV ストアの有効期間は 1 秒以上である）。
 */
function ttlUntil(expiresAt: number): number {
  return Math.max(1, expiresAt - nowSeconds());
}

/**
 * ユーザーのレコードからクレームを組み立てて返す。
 *
 * `sub` には引数の `sub` を使い、ほかのクレームはレコードの `claims` から取る。
 * レコードに `email` があるときだけ、`email` と `email_verified`（`is_verified` の値）を加える。
 */
function userClaims(sub: string, user: UserRecord): UserClaims {
  const claims: UserClaims = { ...(user.claims as Partial<UserClaims>), sub };
  if (user.email !== null) {
    claims.email = user.email;
    claims.email_verified = user.is_verified;
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
 * アクセストークンのレコードの `scope` に保存する値で、スコープがなければ `null` を返す。
 */
function joinScope(scope: string[]): string | null {
  return scope.length > 0 ? scope.join(' ') : null;
}

/**
 * 空白区切りのスコープを配列にして返す。
 *
 * `null` と空文字列には、空の配列を返す。
 */
function splitScope(scope: string | null): string[] {
  return scope ? scope.split(' ') : [];
}

/**
 * 値の SHA-256 ハッシュを base64url で返す。
 *
 * 認可コードとトークンは、この値をキーにして保存する。
 * パディングは付けない。
 */
async function hashKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
