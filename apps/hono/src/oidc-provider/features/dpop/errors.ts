/**
 * EXTENSION (dpop): the failures of the DPoP checks (DpopError). The token and
 * UserInfo endpoints answer them through error-responses.ts; PAR and /authorize
 * answer them in their own steps (bind-pushed-dpop-key, validate-dpop-jkt).
 *
 * DPoP（RFC 9449）の検査が失敗したときのエラー。
 *
 * `error` は OAuth のエラーレスポンスにそのまま載せるエラーコードで、
 * トークンエンドポイントは RFC 6749 §5.2 のエラーレスポンスに、保護されたリソースは
 * `WWW-Authenticate: DPoP` のチャレンジ（RFC 9449 §7.1）に載せる。
 * `errorDescription` は、このディレクトリの検査が決めた固定の文言だけを入れる。
 * クライアントが送った値を含めないので、`error_description` に使えない文字（RFC 6749 §5.2）や
 * `WWW-Authenticate` の値を壊す引用符が入ることはない。
 */

/** DPoP の検査の失敗を表す OAuth のエラーコード。 */
export type DpopErrorCode =
  /** DPoP proof が無い、形式が正しくない、または検証できない（RFC 9449 §5 / §7.1）。 */
  | 'invalid_dpop_proof'
  /** 保護されたリソースに提示されたアクセストークンが、DPoP proof の鍵に束縛されていない（RFC 9449 §7.1 / §7.2）。 */
  | 'invalid_token'
  /** 認可コードかリフレッシュトークンが、DPoP proof と別の鍵に束縛されている（RFC 9449 §5 / §10）。 */
  | 'invalid_grant'
  /** リクエストのパラメータが正しくない（`dpop_jkt` の形式など。RFC 9449 §10）。 */
  | 'invalid_request';

/**
 * DPoP の検査の失敗。
 *
 * `error` と `errorDescription` は、トークンエンドポイントと UserInfo エンドポイントでは `error-responses.ts` の `tokenEndpointErrorOf()` と `userInfoEndpointErrorOf()` が、PAR と認可エンドポイントではそれぞれのステップ（`bind-pushed-dpop-key` と `validate-dpop-jkt`）が、エンドポイントに合ったエラーレスポンスにする。
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
 * 形に合う値を `DpopError` として返す。
 *
 * 形で見分けるのは、別に読み込まれた（バンドルで複製された）このモジュールのエラーも同じに扱うためである。
 * `name` が `DpopError` で、文字列の `error` と `errorDescription` を持つ値を、DPoP の検査の失敗とみなす。
 */
export function isDpopError(value: unknown): value is DpopError {
  if (value instanceof DpopError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { name?: unknown; error?: unknown; errorDescription?: unknown };
  return (
    candidate.name === 'DpopError' &&
    typeof candidate.error === 'string' &&
    typeof candidate.errorDescription === 'string'
  );
}
