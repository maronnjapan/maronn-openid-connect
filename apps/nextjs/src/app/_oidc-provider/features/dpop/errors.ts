/**
 * EXTENSION (dpop): the failure of a DPoP check (DpopError), with the OAuth
 * error code and description to answer it with.
 *
 * DPoP（RFC 9449）の検査が失敗したときのエラー。
 *
 * `error` は、エラーレスポンスにそのまま載せる OAuth のエラーコードである。
 * トークンエンドポイントは RFC 6749 §5.2 のエラーレスポンスに、保護されたリソースは
 * エラーレスポンスと、リクエストがトークンを提示したスキームの `WWW-Authenticate` の
 * チャレンジ（RFC 9449 §7.1 / §7.2）に載せる。
 * どのエンドポイントが返すコードかは、エラーコードの一覧に書く。
 * `errorDescription` には、このディレクトリの検査が決めた固定の文言だけを入れる。
 * クライアントが送った値を含めないので、`error_description` に使えない文字（RFC 6749 §5.2）や
 * `WWW-Authenticate` の値を壊す引用符が入ることはない。
 */

/** DPoP の検査の失敗を表す OAuth のエラーコードの一覧（{@link isDpopError} が形で見分けるときにも使う）。 */
const DPOP_ERROR_CODES = [
  /**
   * DPoP proof が無い、形式が正しくない、または検証できない（RFC 9449 §5 / §7.1）。
   * トークンエンドポイントは 400 で、保護されたリソース（UserInfo エンドポイント）は 401 で応答する。
   */
  'invalid_dpop_proof',
  /**
   * 認可コードかリフレッシュトークンが鍵に束縛されているのに、その鍵の DPoP proof が無い（RFC 9449 §5 / §10）。
   * トークンエンドポイントだけが返す RFC 6749 §5.2 のエラーコードで、保護されたリソースのチャレンジには載せない。
   */
  'invalid_grant',
  /**
   * 保護されたリソース（UserInfo エンドポイント）に提示されたアクセストークンが、提示の仕方に合った鍵に束縛されていない（RFC 9449 §7.1 / §7.2）。
   * DPoP スキームで提示したのに DPoP proof の鍵に束縛されていない、または Bearer で提示したのに DPoP の鍵に束縛されている。
   * 保護されたリソースだけが返す RFC 6750 §3.1 のエラーコードで、401 で応答する。
   */
  'invalid_token',
  /**
   * 保護されたリソースへのリクエストの形が正しくない（RFC 6750 §3.1）。
   * `Authorization: DPoP` の値がアクセストークンを一つの token68 で持たない（RFC 9449 §7.1）。
   * RFC 6749 §5.2 のコードでもあり、トークンエンドポイントも保護されたリソースも 400 で応答する。
   */
  'invalid_request',
] as const;

/** DPoP の検査の失敗を表す OAuth のエラーコード。 */
export type DpopErrorCode = (typeof DPOP_ERROR_CODES)[number];

/**
 * DPoP の検査の失敗。
 *
 * `error` と `errorDescription` は、エンドポイントがこの失敗を答えるエラーレスポンスの `error` と `error_description` にする値である。
 */
export class DpopError extends Error {
  public readonly error: DpopErrorCode;
  public readonly errorDescription: string;

  constructor(error: DpopErrorCode, errorDescription: string) {
    super(errorDescription);
    this.name = 'DpopError';
    this.error = error;
    this.errorDescription = errorDescription;
  }
}

/**
 * 値が DPoP の検査の失敗（`DpopError`）かを、形で見分けて返す。
 *
 * 形で見分けるのは、別に読み込まれた（バンドルで複製された）このモジュールのエラーも同じに扱うためである。
 * `name` が `DpopError` で、`error` が DPoP の検査のエラーコード（`DpopErrorCode`）のどれかで、文字列の `errorDescription` を持つ値を、DPoP の検査の失敗とみなす。
 * ほかのエラーコードを持つ値は、`error` の型が `DpopErrorCode` に合わないので、DPoP の検査の失敗とみなさない。
 */
export function isDpopError(value: unknown): value is DpopError {
  if (value instanceof DpopError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { name?: unknown; error?: unknown; errorDescription?: unknown };
  return (
    candidate.name === 'DpopError' &&
    (DPOP_ERROR_CODES as readonly unknown[]).includes(candidate.error) &&
    typeof candidate.errorDescription === 'string'
  );
}
