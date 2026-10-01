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
 * end_session リクエストのパラメータを正規化する。
 *
 * 重複パラメータは最初の値を採用し（`URLSearchParams.get` の挙動）、空文字は
 * 値なしとして undefined に落とす。空の `id_token_hint` を「ヒントあり」と
 * 数えると、後段の検証失敗と区別が付かないまま分岐だけ増えるため。
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

function nonEmpty(value: string | null): string | undefined {
  return value === null || value === '' ? undefined : value;
}

/**
 * `id_token_hint` の payload から検証に使う期待 audience を抽出する。
 *
 * `client_id` パラメータが無いリクエストでは、core の `validateIdTokenHint` に
 * 渡す `expectedAud` をヒント自身から特定するしかない。これは署名検証**前**の
 * 復号であり、返り値は「この aud で検証を試みる」という候補にすぎない。信頼は
 * その後の `validateIdTokenHint`（署名・iss・aud・exp）が与える。
 *
 * aud の形（OIDC Core §2）ごとの扱い:
 * - 文字列 → その値
 * - 配列 + `azp`（文字列）→ azp の値。core の `buildIdTokenAudience` は追加
 *   audience 構成時に aud を配列にし azp を必ず付与するため、自 OP 発行の
 *   ID Token でもこの経路は必須である
 * - 配列（要素 1・azp なし）→ その要素。自 OP 発行では生じない形だが、署名検証前の
 *   入力に対する処理として許容する
 * - それ以外（複数要素で azp なし、aud 欠落・非文字列）→ null（特定不能）
 *
 * 復号できない・特定できない場合は null を返す。呼び出し側はヒントを無効として
 * 確認画面の経路（§2 MUST）に落とす。
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

/** base64url（パディング無し）の JSON セグメントを厳格にパースする。 */
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
