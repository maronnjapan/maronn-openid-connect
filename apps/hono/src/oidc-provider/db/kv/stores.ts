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
 *    code is issued from it, and token_issued once that code is exchanged.
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
  type AuthTransactionStore,
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
  type UpstreamLoginStorage,
  type UserStorage,
} from '../../store.js';
import { readRecord, writeRecord, type KvDatabase } from './database.js';
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
} from './keys.js';
import { verifyPassword } from './users.js';

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

export function createProviderStores(db: KvDatabase): ProviderStores {
  const read = <T>(key: string) => readRecord<T>(db, key);
  const write = (key: string, record: unknown, ttlSeconds?: number) =>
    writeRecord(db, key, record, ttlSeconds);

  /** The record of a transaction, unless it has expired. */
  const readTransaction = async (transactionId: string): Promise<TransactionRecord | undefined> => {
    const record = await read<TransactionRecord>(keys.transaction(transactionId));
    return record && record.expired_at > nowSeconds() ? record : undefined;
  };

  /** Move a transaction in progress from one of the statuses in from to status. */
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

  /** The record of a grant, changed by change and written back. It lives until expiresAt at least. */
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

  /** Mark the tokens of one kind in a grant revoked, until the grant's last code or token expires. */
  const revokeGrant = async (revokedKey: string, grantId: string): Promise<void> => {
    const grant = await read<GrantRecord>(keys.grant(grantId));
    // Without a grant record every code and token of the grant has expired.
    if (grant) await db.set(revokedKey, MARKER, ttlUntil(grant.expired_at));
  };

  // Transaction + Authentication_request: one record, written in one set.
  const transactionStore: AuthTransactionStore = {
    async get(key) {
      const transactionId = withoutPrefix(key, TRANSACTION_KEY_PREFIX);
      const [record, result] = await Promise.all([
        readTransaction(transactionId),
        db.get(keys.transactionResult(transactionId)),
      ]);
      // A transaction that ended (failed, code_issued, token_issued) is gone for the OP.
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
    // The expiry is the transaction's own expiresAt (milliseconds, rounded up
    // to seconds), which the ttlSeconds core passes is computed from.
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
      // A new transaction starts as requested. Saving it again (a failed
      // sign-in attempt) keeps its status.
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
    // One-time use: the transaction ends as failed, unless a code was issued
    // from it already (code_issued stays).
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
  };

  const authCodeStore: AuthorizationCodeStorage = {
    async set(code, info) {
      // The routes pass core's AuthorizationCodeData, which names the
      // transaction the code was issued from. Neither the raw code nor a value
      // with a field of its own goes into payload.
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
        // The result outlives the transaction until the code expires, so the
        // exchange of the code can still record token_issued.
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
    // Only one of two concurrent requests stores the code_used key; the other
    // one finds the code already used and must not receive tokens.
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
      const { sub, scope, clientId, expiresAt, iat, issuer, jti, grantId, acr, ...payload } = info;
      const tokenHash = await hashKey(token);
      // A token issued without a jti is kept under its hash.
      const id = jti ?? tokenHash;
      // The grant also names the transaction of the code it came from. A grant
      // without a code (the device flow, CIBA) has none.
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
        transaction_id: grant?.transaction_id ?? null,
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
      // The access token of the same token response: the token endpoint stores
      // it just before, with the same grant and iat.
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
    // Rotation: like authCodeStore.consume, exactly one request wins.
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

  // auth_type of a sign-in (auth_user): the provider of the user's federated
  // identity, or password. A user created by an upstream sign-in (such as Sign
  // in with Google) has no password, and registerUser() (users.ts) adds no
  // federated identity, so each user signs in one way only unless you link an
  // upstream account to a user with a password yourself.
  const authTypeOf = async (userId: string): Promise<string> => {
    const user = await read<UserRecord>(keys.user(userId));
    return user?.federated_identities?.[0]?.provider ?? 'password';
  };

  // Auth_user: the sign-in handed from /login to /consent, per transaction.
  // It expires with the transaction.
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
      // An empty request is never treated as consented.
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
    // The grants come back, so the caller revokes the tokens of each one.
    async revoke(subject, clientId) {
      const consent = await readConsent(subject, clientId);
      await db.delete(keys.consent(subject, clientId));
      return consent.grant_ids;
    },
  };

  // The user linked to an account at an upstream identity provider, if any.
  const findFederatedUser = async (provider: string, providerSub: string): Promise<string | undefined> => {
    const identity = await read<FederatedIdentityRecord>(keys.federatedIdentity(provider, providerSub));
    return identity?.user_id;
  };

  // Link an upstream account to a new user, under a new random id, on its
  // first sign-in. Two first sign-ins of one account may race: setIfAbsent
  // keeps one federated identity, and the request that lost uses the user it
  // names.
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

  // Save the claims the upstream provider asserted to the user (email and
  // email_verified to their fields, the others to claims), and create the user
  // record on the first sign-in. password_hash is left as it is.
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

  // User: the user records. Put users there with registerUser() (users.ts).
  const userStore: UserStorage = {
    // The password form checks the user's id as the username.
    async authenticate(username, password) {
      const user = await read<UserRecord>(keys.user(username));
      // verifyPassword() takes as long without a hash, so the response time
      // does not tell whether the user exists. A user without a password
      // cannot sign in with the form.
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
    // Find or create the user of a verified upstream account by its federated
    // identity (never by email), and save the claims the provider asserted.
    async linkFederatedIdentity(identity) {
      const userId =
        (await findFederatedUser(identity.provider, identity.subject)) ??
        (await createFederatedUser(identity.provider, identity.subject));
      const claims: UserClaims = { ...identity.claims, sub: userId };
      await saveFederatedClaims(claims, identity.provider, identity.subject);
      return claims;
    },
  };

  // The upstream sign-in a transaction waits for, kept in the
  // upstream_auth_request record of the transaction, and found by its nonce
  // through upstream_nonce. A transaction has one record, so a newer login
  // page replaces the nonce of an older one. Both expire with the transaction.
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

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The TTL that makes a key expire at expiresAt (epoch seconds), 1 second at least. */
function ttlUntil(expiresAt: number): number {
  return Math.max(1, expiresAt - nowSeconds());
}

/** The claims of a user record: email and email_verified from their fields, the rest from claims. */
function userClaims(sub: string, user: UserRecord): UserClaims {
  const claims: UserClaims = { ...(user.claims as Partial<UserClaims>), sub };
  if (user.email !== null) {
    claims.email = user.email;
    claims.email_verified = user.is_verified;
  }
  return claims;
}

function withoutPrefix(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/** The scope field: space-separated, null when there is none. */
function joinScope(scope: string[]): string | null {
  return scope.length > 0 ? scope.join(' ') : null;
}

function splitScope(scope: string | null): string[] {
  return scope ? scope.split(' ') : [];
}

/** The key a code or token is stored under: its SHA-256 hash, base64url-encoded. */
async function hashKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
