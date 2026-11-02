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
 * `response_mode` を JARM の値かどうかで分類して返す。
 *
 * 認可リクエストの `response_mode` の値に応じて、次を返す。
 * - `query.jwt` と `jwt` なら、JARM のモード（`{ kind: 'jarm', mode: 'query.jwt' }`）。
 *   JARM §2.3.4 では `response_type=code` の既定が `query.jwt` なので、省略形の `jwt` は `query.jwt` と同じ意味になる。
 * - 指定がないとき、文字列でないとき、`query`、`form_post`、`fragment` など `.jwt` で終わらない値なら、`{ kind: 'plain' }`。
 * - `fragment.jwt`、`form_post.jwt` など、そのほかの `.jwt` で終わる値なら、対応していないモード（`{ kind: 'unsupported-jwt-mode', requested }`）。
 *
 * `.jwt` で終わらない値を `{ kind: 'plain' }` にするのは、JARM を有効にしても、この OP がこれまで `response_mode` を無視してきた動作を変えないためである。
 * JARM は `.jwt` で終わる値にだけ意味を加える拡張なので、それ以外の値の扱いを変える必要はない。
 *
 * 値は大文字と小文字を区別して比べる。
 * OAuth 2.0 Multiple Response Type Encoding Practices §2.1 で、`response_mode` の値は大文字と小文字を区別すると定められているためである。
 *
 * @param params 認可リクエストで実際に使うパラメータ（リクエストオブジェクトをマージした後の値）。
 *   `response_mode` 以外のキーは見ない。
 * @spec JARM §2.3.4
 * @spec OAuth 2.0 Multiple Response Type Encoding Practices §2.1
 */
export function resolveJarmResponseMode(params: object): JarmResponseModeResolution {
  // `params` から `response_mode` の値を取り出す。
  // 引数を `object` で受けるのは、core の `AuthorizationRequestParams`（インデックスシグネチャのないインターフェース）も `Record<string, string>` も、そのまま渡せるようにするためである。
  // 値が文字列でないとき（フレームワークがクエリを解析して配列にしたときなど）は、解釈せずに `{ kind: 'plain' }` として扱う。
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
