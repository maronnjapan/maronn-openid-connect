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
 * ログアウト後のリダイレクト先の URL か `null` を返す。
 *
 * 次のどれかに当てはまるときは `null` を返し、呼び出し側はリダイレクトせずに完了画面を表示する。
 * - `verifiedClientId` が `null`（ヒントがないか無効）のとき。
 * - `postLogoutRedirectUri` が指定されていないとき。
 * - `postLogoutRedirectUri` が `registeredUris` のどれとも一致しないとき。
 * - 一致した登録値が相対 URI などで、`URL` として解析できないとき。
 *
 * RP-Initiated Logout 1.0 §3 は、`id_token_hint` を伴わない要求でのリダイレクトと、登録された値と一致しない URI へのリダイレクトを禁じている（MUST NOT）。
 * 一致は文字列の完全一致で判定し、正規化、前方一致、クエリを無視した比較はしない。
 * これは認可エンドポイントの `redirect_uri` の検証と同じ判定で、オープンリダイレクトを防ぐ（RFC 6749 §10.15）。
 *
 * `state` が指定されていれば、`URL` の `searchParams` でクエリに付けてから URL を返す。
 * `state` はこの方法でだけ出力するので、URL エンコードされずにレスポンスに出ることはない。
 *
 * @param options.postLogoutRedirectUri リクエストの `post_logout_redirect_uri` パラメータの値
 * @param options.state リクエストの `state`。
 *   リダイレクトしないときは、どこにも出力しない。
 * @param options.verifiedClientId `decideLogoutFlow()` が返した検証済みのクライアント。
 *   `null` はヒントが無効であることを示し、このときはリダイレクトしない。
 * @param options.registeredUris `verifiedClientId` のクライアントに登録された `post_logout_redirect_uris`。
 *   生成されたコードは、設定から取り出して渡す。
 * @spec RP-Initiated Logout 1.0 §3
 * @spec RFC 6749 §10.15
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
    // 登録された値が相対 URI などで `URL` を組み立てられないときは、リダイレクトしない。
    return null;
  }
  if (state !== undefined) {
    url.searchParams.append('state', state);
  }
  return url.toString();
}
