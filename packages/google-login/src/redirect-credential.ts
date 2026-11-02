/**
 * Sign in with Google の redirect mode で login_uri に届く POST の処理。
 *
 * Google Identity Services（GIS）の `ux_mode: 'redirect'` では、ユーザーがアカウントを
 * 選ぶとブラウザが `login_uri` へ `application/x-www-form-urlencoded` の POST で遷移する
 * （Google のドキュメント「Google ログインからの移行」の redirect mode）。本文には
 *
 *   - `credential`: Google が発行した ID トークン（JWT）
 *   - `g_csrf_token`: Double Submit Cookie 用の値
 *   - `select_by`: ユーザーがどの UI で選択したか（例: `btn`, `user`）
 *
 * が入り、GIS クライアントが同じ値を `g_csrf_token` Cookie にも設定している。
 * login_uri は Cookie と本文の `g_csrf_token` が一致することを確認してから ID トークンを
 * 検証しなければならない（ドキュメント「サーバーサイドで Google ID トークンを検証する」の
 * CSRF 対策）。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { GoogleLoginError, GoogleLoginErrorCode } from './errors.js';

/** POST 本文で ID トークンが入るパラメータ名。 */
export const GOOGLE_CREDENTIAL_PARAM = 'credential';
/** POST 本文で Double Submit Cookie の値が入るパラメータ名。 */
export const GOOGLE_CSRF_TOKEN_PARAM = 'g_csrf_token';
/** GIS クライアントが設定する Double Submit Cookie の名前。 */
export const GOOGLE_CSRF_TOKEN_COOKIE = 'g_csrf_token';
/** POST 本文で選択方法が入るパラメータ名。 */
export const GOOGLE_SELECT_BY_PARAM = 'select_by';

/**
 * POST 本文の読み取り元。
 *
 * 生成コードはフレームワークの本文パーサーの結果（`Record<string, ...>`）、
 * `URLSearchParams`、`FormData` のどれでも渡せる。
 */
export type GoogleLoginParamsSource =
  | Record<string, unknown>
  | URLSearchParams
  | FormData;

/** login_uri へ届いた POST から取り出した値。 */
export interface GoogleRedirectCredential {
  /** Google が発行した ID トークン（未検証）。 */
  credential: string;
  /** POST 本文の `g_csrf_token`。無ければ undefined（{@link validateGoogleCsrfToken} が拒否する）。 */
  csrfToken?: string;
  /**
   * `select_by`。GIS がユーザーの選択方法を表す値（`auto` / `user` / `user_1tap` /
   * `user_2tap` / `btn` / `btn_confirm` / `btn_add_session` / `btn_confirm_add_session` など）。
   * 監査ログ向けの参考情報で、検証には使わない。
   */
  selectBy?: string;
}

/**
 * ボディから `name` の値を取り出し、文字列なら返す。
 *
 * `source` が `URLSearchParams` か `FormData` なら `get()` で読み、それ以外のオブジェクトならプロパティを読む。
 * 値がないときと、文字列でないとき（`FormData` の `File` や、フレームワークがボディを解析して作った配列など）は `undefined` を返す。
 */
export function readGoogleLoginParam(source: GoogleLoginParamsSource, name: string): string | undefined {
  const value =
    source instanceof URLSearchParams || source instanceof FormData
      ? source.get(name)
      : source[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * ボディから ID トークンと `g_csrf_token` を取り出す。
 *
 * `login_uri` に届いた POST のボディから `credential`（ID トークン）、`g_csrf_token`、`select_by` を読み、空でない値だけを結果に入れて返す。
 * `g_csrf_token` がなくてもここでは投げず、{@link validateGoogleCsrfToken} が拒否する。
 *
 * @throws {GoogleLoginError} `missing_credential`: `credential` がないか空文字のとき
 */
export function parseGoogleRedirectCredential(source: GoogleLoginParamsSource): GoogleRedirectCredential {
  const credential = readGoogleLoginParam(source, GOOGLE_CREDENTIAL_PARAM);
  if (!credential) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.MissingCredential,
      'No credential in post body.',
    );
  }

  const result: GoogleRedirectCredential = { credential };

  const csrfToken = readGoogleLoginParam(source, GOOGLE_CSRF_TOKEN_PARAM);
  if (csrfToken) {
    result.csrfToken = csrfToken;
  }
  const selectBy = readGoogleLoginParam(source, GOOGLE_SELECT_BY_PARAM);
  if (selectBy) {
    result.selectBy = selectBy;
  }
  return result;
}

/**
 * `Cookie` ヘッダーの `g_csrf_token` の値を返す。
 *
 * 名前と値の前後の空白は取り除いて扱い、最初に見つかった `g_csrf_token` の値を返す。
 * ヘッダーがないとき、`g_csrf_token` がないとき、その値が空のときは `undefined` を返す。
 */
export function parseGoogleCsrfTokenCookie(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() === GOOGLE_CSRF_TOKEN_COOKIE) {
      const value = trimmed.slice(eq + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

/**
 * 文字列を定数時間で比べ、等しければ `true` を返す。
 *
 * `crypto.timingSafeEqual` は同じ長さのバッファしか比べられないので、それぞれの SHA-256 のダイジェスト（どちらも 32 バイト）どうしを比べる。
 * そのため、文字列の長さの違いも比較にかかる時間に表れない。
 */
function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Cookie とボディの `g_csrf_token` の一致を検証する。
 *
 * ダブルサブミット Cookie による CSRF 対策である。
 * GIS は同じ値を `g_csrf_token` の Cookie と POST のボディの両方に入れるので、両者が一致しない POST を拒否する。
 *
 * Google のドキュメントのサンプルと同じ順に、次の三つを確かめる。
 * 1. Cookie に `g_csrf_token` がある。
 * 2. ボディに `g_csrf_token` がある。
 * 3. 両者が一致する（定数時間で比べる）。
 *
 * @param bodyToken ボディの `g_csrf_token`
 * @param cookieToken Cookie の `g_csrf_token`
 * @throws {GoogleLoginError} `csrf_token_missing_in_cookie`: Cookie に値がないとき
 * @throws {GoogleLoginError} `csrf_token_missing_in_body`: ボディに値がないとき
 * @throws {GoogleLoginError} `csrf_token_mismatch`: 両者が一致しないとき
 */
export function validateGoogleCsrfToken(
  bodyToken: string | undefined,
  cookieToken: string | undefined,
): void {
  if (!cookieToken) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.CsrfTokenMissingInCookie,
      'No CSRF token in Cookie.',
    );
  }
  if (!bodyToken) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.CsrfTokenMissingInBody,
      'No CSRF token in post body.',
    );
  }
  if (!constantTimeEqual(bodyToken, cookieToken)) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.CsrfTokenMismatch,
      'Failed to verify double submit cookie.',
    );
  }
}
