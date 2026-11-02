/**
 * Scope policy for this provider.
 *
 * This module is the single place the generated provider asks its two scope
 * questions. It deliberately imports nothing, so both answers can be
 * rewritten — including against a database — without touching an endpoint.
 * The CLI writes CUSTOM_SCOPES from its `--scope` option.
 *
 * 1. "May this value be requested at all?" — `findUnsupportedScopes()`, called by
 *    the authorization endpoint (and by the device / CIBA request endpoints when
 *    those features are generated). Once a custom scope is declared, a value
 *    that is neither standard nor declared here is rejected with
 *    `invalid_scope` (RFC 6749 §3.3 / §4.1.2.1). Without one, any value is
 *    accepted.
 * 2. "May THIS End-User be granted it?" — `resolveGrantableScopes()`, called from
 *    every step that turns a request into a grant. **This is where per-user scope
 *    filtering goes**; see its doc comment below.
 *
 * Custom scopes carry no UserInfo claims of their own: OIDC Core 1.0 §5.4 defines
 * claims for profile / email / address / phone only, so `filterClaimsByScope()`
 * ignores them. Return your own claims for a custom scope by editing the
 * resolve-claims step of endpoints/userinfo/.
 */

/**
 * Scopes this provider implements itself and always accepts: `openid` (OIDC Core
 * 1.0 §3.1.2.1), the four claim scopes (§5.4) and `offline_access` (§11).
 */
export const STANDARD_SCOPES: readonly string[] = ['openid', 'profile', 'email', 'address', 'phone', 'offline_access'];

/** Declared with `--scope`: the custom scopes this provider accepts. */
export const CUSTOM_SCOPES: readonly string[] = [];

/**
 * OIDC Discovery 1.0 §3 `scopes_supported`: the scopes of OIDC Core and the
 * custom ones. offline_access is advertised by the refresh-token feature,
 * because only that feature grants it. It is OP metadata, so it lists what
 * the provider supports — not what a particular End-User ends up being
 * granted, which resolveGrantableScopes() decides.
 */
export const ADVERTISED_SCOPES: readonly string[] = ['openid', 'profile', 'email', 'address', 'phone', ...CUSTOM_SCOPES];

/**
 * Per-End-User scope restrictions, keyed by scope: only the listed subjects may
 * be granted that scope. Empty by default, so every accepted scope is grantable
 * to every authenticated End-User.
 *
 * This is the quickest way to restrict a scope — uncomment and fill in. For
 * anything richer (roles, tenants, a database), write it in
 * resolveGrantableScopes() below instead.
 */
export const RESTRICTED_SCOPE_SUBJECTS: Record<string, readonly string[]> = {
  // 'reports.read': ['testuser'],
};

/**
 * 要求されたスコープを、付与してよいものに絞って返す。
 *
 * `RESTRICTED_SCOPE_SUBJECTS` に載っているスコープは、そこに挙げたサブジェクトのときだけ残し、載っていないスコープはそのまま残す。
 *
 * ユーザーごとにスコープを絞る処理は、この関数に書く。
 * この関数はエンドユーザーが決まったあとで呼ばれ、グラントを決める次のステップは、どれもすでにこの関数を待っている。
 * - 同意画面（表示するスコープ）と承認（付与するスコープ）。
 * - 認可エンドポイントで、SSO と `prompt=none` によって同意画面を出さずにグラントを決める処理。
 *   どちらも、保存された同意を探す前に絞る。
 *   サブジェクトが持てないスコープで同意を探しても、一致することはないからである。
 * - デバイスと CIBA の承認のステップ（それらの機能を生成したとき）。
 *
 * 非同期の関数にしてあるので、呼び出し元を変えずに、データベースや KV を引く処理を入れられる。
 * `requested` には標準のスコープも含まれるので、標準のスコープも絞れる。
 *
 * スコープを除いても、リクエストは失敗させずにグラントを狭める。
 * 認可サーバーは要求より狭いスコープを発行してよく、トークンレスポンスは付与した `scope` を示す（RFC 6749 §3.3）。
 * リクエスト全体を拒否したいときは、フローに合う呼び出し元で例外を投げる。
 */
export async function resolveGrantableScopes(
  requested: readonly string[],
  subject: string,
): Promise<string[]> {
  return requested.filter((scope) => {
    const allowedSubjects = RESTRICTED_SCOPE_SUBJECTS[scope];
    return allowedSubjects === undefined || allowedSubjects.includes(subject);
  });
}

/**
 * 要求のうち、OP が受け付けないスコープを返す。
 *
 * 標準のスコープ（`STANDARD_SCOPES`）にも独自のスコープ（`CUSTOM_SCOPES`）にもない値を返す。
 * 結果が空でなければ、呼び出し側はリクエストを `invalid_scope` で拒否する（RFC 6749 §3.3）。
 * 独自のスコープを一つも宣言していないうちは比べる一覧がないので、空の配列を返し、どの値も受け付ける。
 */
export function findUnsupportedScopes(requested: readonly string[]): string[] {
  if (CUSTOM_SCOPES.length === 0) return [];
  return requested.filter((scope) => !STANDARD_SCOPES.includes(scope) && !CUSTOM_SCOPES.includes(scope));
}
