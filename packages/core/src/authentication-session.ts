/**
 * OP の認証セッション（End-User がログインしている状態）を表す型。
 *
 * OIDC Core 1.0 §11 は `offline_access` を「End-User が居ない（not logged in）ときにも
 * 使える Refresh Token を要求する scope」と定義し、末尾で
 * > The use of Refresh Tokens is not exclusive to the `offline_access` use case.
 * > The Authorization Server MAY grant Refresh Tokens in other contexts that are
 * > beyond the scope of this specification.
 * と述べている。本ライブラリはその「other contexts」を **online refresh token** として
 * 実装する。online refresh token は発行元の認証セッションへ束縛され、セッションが
 * 終われば（別ユーザーでのログインし直し、セッション削除など）使えなくなる。
 *
 * この 2 種類は「ユーザーが居なくなった後も動くか」で分かれる。
 *
 * | | online refresh token | offline refresh token |
 * |---|---|---|
 * | 付与条件 | クライアントが `refresh_token` grant を登録 | 加えて `offline_access` の付与（OIDC Core 1.0 §11） |
 * | セッション | 束縛する（{@link RefreshTokenInfo.sessionId}） | 束縛しない |
 * | セッション終了後 | `invalid_grant` | 使い続けられる |
 *
 * OP がセッションをどう保持するか（Cookie / KV / DB）は生成コード側の責務なので、
 * core は「セッション id からこの最小情報を引ける」ことだけを契約として要求する。
 */

/** 認証セッションの最小情報。 */
export interface AuthenticationSessionInfo {
  /** このセッションで認証されている End-User の識別子。 */
  subject: string;
  /** 認証時刻（Unix epoch 秒）。OIDC Core 1.0 §2 の `auth_time` に対応。 */
  authTime: number;
}

/**
 * 認証セッションを解決するインターフェース。
 *
 * 実装は「セッションが終了している」場合に `null` を返さなければならない。
 * 終了済みセッションを返し続けると online refresh token が失効しなくなる。
 */
export interface AuthenticationSessionResolver {
  findSession(sessionId: string): Promise<AuthenticationSessionInfo | null>;
}
