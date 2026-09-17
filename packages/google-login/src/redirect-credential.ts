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
 * 読み取り元から文字列パラメータを 1 つ取り出す。文字列でない値（File など）は無視する。
 */
export function readGoogleLoginParam(source: GoogleLoginParamsSource, name: string): string | undefined {
  const value =
    source instanceof URLSearchParams || source instanceof FormData
      ? source.get(name)
      : source[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * ステップ 1: login_uri へ届いた POST 本文から `credential` / `g_csrf_token` / `select_by` を取り出す。
 *
 * @throws {GoogleLoginError} `missing_credential`
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
 * ステップ 2: `Cookie` ヘッダーから `g_csrf_token` の値を取り出す。無ければ undefined。
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
 * 2 つの文字列を constant-time で比較する。
 *
 * `crypto.timingSafeEqual` は同じ長さのバッファしか比較できないので、固定長の
 * SHA-256 ダイジェスト同士を比較する（長さの違いも応答時間に出ない）。
 */
function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * ステップ 3: Double Submit Cookie を検証する。
 *
 * Google のドキュメントのサンプルと同じ順序で判定する。
 *
 *   1. Cookie に `g_csrf_token` が無い → 拒否
 *   2. POST 本文に `g_csrf_token` が無い → 拒否
 *   3. 両者が一致しない → 拒否
 *
 * @param bodyToken POST 本文の `g_csrf_token`
 * @param cookieToken Cookie の `g_csrf_token`
 * @throws {GoogleLoginError} `csrf_token_missing_in_cookie` / `csrf_token_missing_in_body` / `csrf_token_mismatch`
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
