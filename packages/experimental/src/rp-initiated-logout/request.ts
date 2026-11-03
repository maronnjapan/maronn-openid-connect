/**
 * OpenID Connect RP-Initiated Logout 1.0 — end_session リクエストの正規化。
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * §2: OP は GET と POST の両方でログアウト要求を受理しなければならない。
 * 生成コードは GET なら URL クエリ、POST なら `application/x-www-form-urlencoded`
 * のボディを URLSearchParams にしてここへ渡す。
 */

/** end_session_endpoint のリクエストパラメータ（RP-Initiated Logout 1.0 §2）。 */
export interface EndSessionRequest {
  /** RECOMMENDED。過去に発行した ID Token（ログアウト権限の証拠）。 */
  idTokenHint?: string;
  /** OPTIONAL。指定時はヒントの aud と一致しなければならない（§2 MUST）。 */
  clientId?: string;
  /** OPTIONAL。登録値との完全一致時のみ使用する（§3）。 */
  postLogoutRedirectUri?: string;
  /** OPTIONAL。解釈せず、リダイレクト時にそのまま返す（§3）。 */
  state?: string;
  /** OPTIONAL。受理するが使用しない（本機能の非目標）。 */
  logoutHint?: string;
  /** OPTIONAL。受理するが使用しない（本機能の非目標）。 */
  uiLocales?: string;
}

/**
 * ログアウトのリクエストからパラメータを取り出して返す。
 *
 * 取り出すのは `id_token_hint`、`client_id`、`post_logout_redirect_uri`、`state`、`logout_hint`、`ui_locales` である。
 * 同じパラメータが複数あれば最初の値を使い（`URLSearchParams.get()` の動作）、空文字列は値なしとして `undefined` にする。
 *
 * 空文字列を `undefined` にするのは、空の `id_token_hint` を「ヒントあり」と数えると、後の検証の失敗と区別がつかないまま場合分けだけが増えるためである。
 *
 * @spec RP-Initiated Logout 1.0 §2
 */
export function parseEndSessionRequest(params: URLSearchParams): EndSessionRequest {
  return {
    idTokenHint: nonEmpty(params.get('id_token_hint')),
    clientId: nonEmpty(params.get('client_id')),
    postLogoutRedirectUri: nonEmpty(params.get('post_logout_redirect_uri')),
    state: nonEmpty(params.get('state')),
    logoutHint: nonEmpty(params.get('logout_hint')),
    uiLocales: nonEmpty(params.get('ui_locales')),
  };
}

/**
 * `null` と空文字列を `undefined` にして返す。
 *
 * それ以外の値はそのまま返す。
 * 空白だけの値も、空白を取り除かずに返す。
 */
function nonEmpty(value: string | null): string | undefined {
  return value === null || value === '' ? undefined : value;
}

/**
 * `id_token_hint` から検証用の `aud` を取り出して返す。
 *
 * `client_id` パラメータがないリクエストでは、core の `validateIdTokenHint()` に渡す `expectedAud` を、ヒント自身から決めるしかない。
 * ここでは署名を検証する前にペイロードを読み取るので、返す値は「この `aud` で検証を試みる」候補にすぎない。
 * 値を信頼してよいかは、その後の `validateIdTokenHint()`（署名、`iss`、`aud`、`exp` の検証）で決まる。
 *
 * ペイロードの `aud` の形（OIDC Core 1.0 §2）に応じて、次の値を返す。
 * - 文字列なら、その値。
 * - 配列で `azp` が文字列なら、`azp` の値。
 *   core の `buildIdTokenAudience()` は、オーディエンスを追加するときに `aud` を配列にして必ず `azp` を付けるので、この OP が発行した ID トークンでもこの場合分けが要る。
 * - 要素が一つの配列で、`azp` が文字列でなければ、その要素（文字列のとき）。
 *   この OP が発行する ID トークンにはない形だが、署名を検証する前の入力として受け付ける。
 * - それ以外（要素が複数で `azp` がない、`aud` がない、文字列でない）は `null`。
 *
 * `.` で 3 つに分かれない値や、ペイロードを base64url の JSON オブジェクトとして読めない値にも `null` を返す。
 * `null` を受け取った呼び出し側は、ヒントを無効として確認画面を出す（RP-Initiated Logout 1.0 §2 の MUST）。
 *
 * @spec RP-Initiated Logout 1.0 §2
 * @spec OIDC Core 1.0 §2
 */
export function extractIdTokenHintAudience(idTokenHint: string): string | null {
  const parts = idTokenHint.split('.');
  if (parts.length !== 3) {
    return null;
  }
  let payload: Record<string, unknown>;
  try {
    payload = parseBase64UrlJson(parts[1] as string);
  } catch {
    return null;
  }
  const aud = payload['aud'];
  if (typeof aud === 'string') {
    return aud;
  }
  if (Array.isArray(aud)) {
    const azp = payload['azp'];
    if (typeof azp === 'string') {
      return azp;
    }
    if (aud.length === 1 && typeof aud[0] === 'string') {
      return aud[0];
    }
  }
  return null;
}

/**
 * base64url の JSON を解析してオブジェクトを返す。
 *
 * 空文字列、英数字と `-`、`_` 以外の文字（パディングの `=` を含む）を含む値、JSON のオブジェクトとして解析できない値（配列や `null` など）には、例外を投げる。
 */
function parseBase64UrlJson(segment: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error('invalid base64url');
  }
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('not a JSON object');
  }
  return parsed as Record<string, unknown>;
}
