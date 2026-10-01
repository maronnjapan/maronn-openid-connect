/**
 * OpenID Connect RP-Initiated Logout 1.0 — post_logout_redirect_uri の解決。
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * §3: `post_logout_redirect_uri` の値は、クライアントに事前登録された
 * `post_logout_redirect_uris` のいずれかと一致しない限り使用してはならない
 * （MUST NOT）。また `id_token_hint` が併せて供給されない要求ではリダイレクト
 * してはならない。この関数はその両方を満たす場合だけ URL を返す純関数。
 */

/**
 * リダイレクト先 URL を確定する。条件を満たさなければ null（呼び出し側は
 * 完了画面を表示する。fail-closed）。
 *
 * 完全一致は文字列比較で行い、正規化・前方一致・クエリ無視をしない
 * （authorize の redirect_uri 検証と同じ判断。RFC 6749 §10.15 のオープン
 * リダイレクタ回避）。`state` は URL API のクエリ付加でのみ出力するため、
 * URL エンコードを通らずに応答へ出る経路はない。
 *
 * @param options.postLogoutRedirectUri リクエストのパラメータ値
 * @param options.state リクエストの `state`。リダイレクトしない場合はどこにも出力されない
 * @param options.verifiedClientId `decideLogoutFlow` が返した検証済みクライアント
 *   （null はヒント無効 = §3 によりリダイレクト禁止）
 * @param options.registeredUris verifiedClientId に登録された
 *   `post_logout_redirect_uris`（生成コードの設定から引く）
 */
export function resolvePostLogoutRedirect(options: {
  postLogoutRedirectUri: string | undefined;
  state: string | undefined;
  verifiedClientId: string | null;
  registeredUris: readonly string[];
}): string | null {
  const { postLogoutRedirectUri, state, verifiedClientId, registeredUris } = options;

  if (verifiedClientId === null || postLogoutRedirectUri === undefined) {
    return null;
  }
  if (!registeredUris.includes(postLogoutRedirectUri)) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(postLogoutRedirectUri);
  } catch {
    // 登録簿に相対 URI などの不正値が紛れていた場合。組み立てられない値へは
    // リダイレクトしない。
    return null;
  }
  if (state !== undefined) {
    url.searchParams.append('state', state);
  }
  return url.toString();
}
