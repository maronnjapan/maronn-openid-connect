/**
 * JWT Secured Authorization Response Mode (JARM) — response_mode interpretation.
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * JARM §2.3 は `query.jwt` / `fragment.jwt` / `form_post.jwt` / `jwt` の 4 値を
 * `response_mode` に追加する。この OP は `response_type=code` 専用なので
 * `query.jwt`（と §2.3.4 でその別名になる `jwt`）だけを実装する。
 */

/** JARM モードとして解釈するリクエスト値（JARM §2.3.1 / §2.3.4）。 */
export const JARM_SUPPORTED_RESPONSE_MODES = ['query.jwt', 'jwt'] as const;

/** 応答 JWT を運ぶクエリパラメータ名（JARM §2.3.1）。他の名前は使わない。 */
export const JARM_RESPONSE_PARAM = 'response';

/**
 * `response_mode` の分類結果。
 *
 * 例外ではなく判別共用体を返すのは、`unsupported-jwt-mode` を検出できる時点
 * （パラメータ解釈時）と、それをリダイレクト可能エラーにできる時点
 * （redirect_uri 確定後）が呼び出し側で異なるため。エラー化は生成コードが
 * core の `AuthorizationError('invalid_request', ...)` で行う。
 */
export type JarmResponseModeResolution =
  /** JARM モード。応答を JWT 化し `response` パラメータで返す。 */
  | { kind: 'jarm'; mode: 'query.jwt' }
  /** 従来どおりの平文クエリ応答。挙動は一切変わらない。 */
  | { kind: 'plain' }
  /** 本 OP が対応しない `.jwt` 系モード。呼び出し側が invalid_request にする。 */
  | { kind: 'unsupported-jwt-mode'; requested: string };

/**
 * 認可リクエストの `response_mode` を JARM の観点で分類する。
 *
 * - `query.jwt` / `jwt` → JARM モード（§2.3.4: `response_type=code` の既定運搬は
 *   `query.jwt` なので、省略形 `jwt` は `query.jwt` と同義）
 * - 未指定 / `query` / `form_post` / `fragment` / その他の非 `.jwt` 値 → 従来どおり
 *   無視する（隔離原則。JARM は `.jwt` 系にだけ意味を足す拡張であり、この OP が
 *   今まで response_mode を無視してきた挙動を JARM 有効化で変えない）
 * - `fragment.jwt` / `form_post.jwt` / その他の `.jwt` 終端値 → 非対応として報告
 *
 * 値の比較は大文字小文字を区別する（OAuth 2.0 Multiple Response Type Encoding
 * Practices §2.1 の response_mode 値は case-sensitive）。
 *
 * @param params 認可リクエストの実効パラメータ（Request Object マージ後）。
 *   `response_mode` 以外のキーは参照しない。
 */
export function resolveJarmResponseMode(params: object): JarmResponseModeResolution {
  // 引数を `object` で受けるのは、core の `AuthorizationRequestParams`（index
  // signature を持たない interface）と素の `Record<string, string>` の双方を
  // そのまま渡せるようにするため。値が文字列でない場合（フレームワークの
  // クエリパーサが配列を返す等）は解釈せず plain として扱う。
  const responseMode = (params as { response_mode?: unknown })['response_mode'];
  if (typeof responseMode !== 'string') {
    return { kind: 'plain' };
  }
  if ((JARM_SUPPORTED_RESPONSE_MODES as readonly string[]).includes(responseMode)) {
    return { kind: 'jarm', mode: 'query.jwt' };
  }
  if (responseMode.endsWith('.jwt')) {
    return { kind: 'unsupported-jwt-mode', requested: responseMode };
  }
  return { kind: 'plain' };
}
