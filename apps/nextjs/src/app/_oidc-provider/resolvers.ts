/**
 * The resolvers core takes, on one set of ProviderStores (store.ts).
 *
 * Build them over one coherent store set: a request must never mix resolvers
 * of one backend with stores of another.
 */
import type {
  AccessTokenInfo,
  AccessTokenResolver,
  AuthenticationSessionInfo,
  AuthenticationSessionResolver,
  AuthorizationCodeInfo,
  AuthorizationCodeResolver,
  ConsentResolver,
  RefreshTokenInfo,
  RefreshTokenResolver,
  SessionInfo,
  SessionResolver,
  UserClaims,
  UserClaimsResolver,
} from '@maronn-openid-connect/core';
import { parseSessionId } from './cookies';
import type { ProviderStores } from './store';

/** A ConsentResolver that also records the grants issued under a consent. */
export type GrantAwareConsentResolver = ConsentResolver & {
  /**
   * クライアントへの同意にグラント ID を記録する。
   *
   * 同意を取り消すと、記録したグラントのトークンもまとめて失効する。
   */
  recordGrant(subject: string, clientId: string, grantId: string): Promise<void>;
};

export type StoreResolvers = ReturnType<typeof createStoreResolvers>;

/**
 * ストアの上に core のリゾルバを作って返す。
 *
 * 返すのは、認可コード、アクセストークン、リフレッシュトークン、ユーザーのクレーム、セッション、同意の各リゾルバと、`revokeConsentAndTokens()` である。
 * どのルートハンドラも、core が定めた同じインターフェースを通してストアを読み書きする。
 *
 * - 認可コードとリフレッシュトークンを失効させるとき（`revokeAuthorizationCode`、`revokeRefreshToken`）は、レコードを消さずに使用済みにする（`consume()`）。
 * - `revokeTokensByGrantId` は、そのグラントのアクセストークンとリフレッシュトークンをすべて失効させる。
 * - ブラウザのセッションは、`sessionResolver` がリクエストの `Cookie` ヘッダーの `session_id` から読み、`authenticationSessionResolver` が保存したセッション ID から読む。
 * - 同意を取り消すとき（`revokeConsent` と `revokeConsentAndTokens()`）は、同意を消し、その同意に記録したグラントのトークンも失効させる。
 */
export function createStoreResolvers(stores: ProviderStores) {
  const {
    authCodeStore,
    accessTokenStore,
    refreshTokenStore,
    userStore,
    browserSessionStore,
    consentStore,
  } = stores;

  const authorizationCodeResolver: AuthorizationCodeResolver = {
    async findAuthorizationCode(code: string): Promise<AuthorizationCodeInfo | null> {
      return (await authCodeStore.get(code)) ?? null;
    },
    async revokeAuthorizationCode(code: string): Promise<void> {
      await authCodeStore.consume(code);
    },
    async revokeTokensByGrantId(grantId: string): Promise<void> {
      await accessTokenStore.revokeByGrantId(grantId);
      await refreshTokenStore.revokeByGrantId(grantId);
    },
  };

  const accessTokenResolver: AccessTokenResolver = {
    async findAccessToken(token: string): Promise<AccessTokenInfo | null> {
      return (await accessTokenStore.get(token)) ?? null;
    },
  };

  const refreshTokenResolver: RefreshTokenResolver = {
    async resolve(token: string): Promise<RefreshTokenInfo | null> {
      return (await refreshTokenStore.get(token)) ?? null;
    },
    async revokeRefreshToken(token: string): Promise<void> {
      await refreshTokenStore.consume(token);
    },
    async revokeTokensByGrantId(grantId: string): Promise<void> {
      await accessTokenStore.revokeByGrantId(grantId);
      await refreshTokenStore.revokeByGrantId(grantId);
    },
  };

  const userClaimsResolver: UserClaimsResolver = {
    async findUserClaims(sub: string): Promise<UserClaims | null> {
      return (await userStore.getClaims(sub)) ?? null;
    },
  };

  const sessionResolver: SessionResolver = {
    async resolve(request: Request): Promise<SessionInfo | null> {
      const sessionId = parseSessionId(request.headers.get('Cookie'));
      if (!sessionId) return null;
      const session = await browserSessionStore.get(sessionId);
      if (!session) return null;
      // サブジェクトとログインした時刻に加えて、セッション ID も返す。
      // セッション ID は認可コードへ引き継がれ、トークンエンドポイントでオンラインのリフレッシュトークンをこのセッションに結び付けるのに使う。
      return { subject: session.subject, authTime: session.authTime, sessionId };
    },
  };

  // オンラインのリフレッシュトークンを結び付けたセッションを、セッション ID から読むリゾルバを作る。
  // `sessionResolver` はブラウザのリクエストの Cookie からセッションを読むが、トークンエンドポイントへのリクエストにはエンドユーザーの Cookie が付かないので、保存したセッション ID から直接読むこのリゾルバが要る。
  // 終了したセッションには、必ず `null` を返すようにする。
  // 返し続けると、ログアウトしたあともオンラインのリフレッシュトークンが使えてしまう。
  const authenticationSessionResolver: AuthenticationSessionResolver = {
    async findSession(sessionId: string): Promise<AuthenticationSessionInfo | null> {
      const session = await browserSessionStore.get(sessionId);
      if (!session) return null;
      return { subject: session.subject, authTime: session.authTime };
    },
  };

  const consentResolver: GrantAwareConsentResolver = {
    async hasConsent(subject: string, clientId: string, scopes: string[]): Promise<boolean> {
      return consentStore.hasConsent(subject, clientId, scopes);
    },
    async recordConsent(subject: string, clientId: string, scopes: string[]): Promise<void> {
      await consentStore.grant(subject, clientId, scopes);
    },
    async recordGrant(subject: string, clientId: string, grantId: string): Promise<void> {
      await consentStore.recordGrant(subject, clientId, grantId);
    },
    async revokeConsent(subject: string, clientId: string): Promise<void> {
      await revokeConsentAndTokens(stores, subject, clientId);
    },
  };

  return {
    authorizationCodeResolver,
    accessTokenResolver,
    refreshTokenResolver,
    authenticationSessionResolver,
    userClaimsResolver,
    sessionResolver,
    consentResolver,
    revokeConsentAndTokens: (subject: string, clientId: string) => revokeConsentAndTokens(stores, subject, clientId),
  };
}

/** 同意を取り消し、その同意に記録したグラントのアクセストークンとリフレッシュトークンを失効させる。 */
export async function revokeConsentAndTokens(stores: ProviderStores, subject: string, clientId: string): Promise<void> {
  const grantIds = await stores.consentStore.revoke(subject, clientId);
  for (const grantId of grantIds) {
    await stores.accessTokenStore.revokeByGrantId(grantId);
    await stores.refreshTokenStore.revokeByGrantId(grantId);
  }
}
