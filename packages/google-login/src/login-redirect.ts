/**
 * `login_uri`（リダイレクトモードで Google がログインの結果を POST する先）の処理を、一つの関数にまとめたもの。
 *
 *   1. `Cookie` ヘッダーと POST のボディから `g_csrf_token` を取り出し、ダブルサブミット Cookie の照合をする
 *   2. `credential`（ID トークン）を `google-auth-library` で検証し（署名、有効期限、`iss`、`aud`）、指定があれば `hd` と `email_verified` も確かめる
 *   3. 検証した ID トークンの `nonce` からログイン試行の記録を探し、認証トランザクションの ID を取り出す
 *
 * 返した `transactionId` を core の `getAuthTransaction` に渡すと、ユーザー名とパスワードでのログインと同じ手順で、認証セッションを確立して同意のステップへ進める。
 *
 * 生成されたコードはこの関数を呼ぶ。
 * 検証を削ったり独自の処理を差し込んだりするときは、この関数の代わりに、中で呼んでいる個々の関数を順に呼ぶ形に書き換える。
 */
import { GoogleLoginError, GoogleLoginErrorCode } from './errors.js';
import { verifyGoogleIdToken } from './id-token.js';
import type { GoogleIdTokenPayload, GoogleIdTokenVerifier } from './id-token.js';
import { consumeGoogleLoginNonce } from './nonce.js';
import type { GoogleLoginNonceStore } from './nonce.js';
import {
  parseGoogleCsrfTokenCookie,
  parseGoogleRedirectCredential,
  validateGoogleCsrfToken,
} from './redirect-credential.js';
import type { GoogleLoginParamsSource } from './redirect-credential.js';

export interface GoogleLoginRedirectContext {
  /** POST 本文。 */
  params: GoogleLoginParamsSource;
  /** リクエストの `Cookie` ヘッダー。 */
  cookieHeader: string | null | undefined;
  /** `aud` と突き合わせるクライアント ID。 */
  clientId: string | readonly string[];
  /** ログイン画面の描画時に nonce を保存したストア。 */
  nonceStore: GoogleLoginNonceStore;
  /** ID トークンの verifier。既定はプロセス共有の google-auth-library 版。 */
  verifier?: GoogleIdTokenVerifier;
  /** 指定すると `hd` の一致を要求する。 */
  hostedDomain?: string | readonly string[];
  /** true なら `email_verified: true` を要求する。 */
  requireVerifiedEmail?: boolean;
  /** nonce の期限判定に使う現在時刻。既定は現在時刻。テストでの差し替え用。 */
  now?: Date;
}

export interface GoogleLoginRedirectResult {
  /** この Google ログインが属する認証トランザクションの ID。core の `getAuthTransaction` に渡す。 */
  transactionId: string;
  /** 検証済みの Google アカウント（ID トークンのペイロード）。 */
  account: GoogleIdTokenPayload;
  /** POST 本文の `select_by`。 */
  selectBy?: string;
}

/**
 * POST を検証し、トランザクション ID などを返す。
 *
 * 返すのは、`nonce` を発行したトランザクションの ID と、検証済みの Google アカウント（ID トークンのペイロード）である。
 * 「Google でログイン」（リダイレクトモード）を終えたブラウザが `login_uri` へ送る POST を、次の順に処理する。
 * 1. `Cookie` ヘッダーから `g_csrf_token` を、ボディから `credential`（ID トークン）、`g_csrf_token`、`select_by` を取り出す。
 * 2. Cookie とボディの `g_csrf_token` が一致することを確かめる（ダブルサブミット Cookie）。
 * 3. ID トークンを検証し、オプションで求めたときは `hd` と `email_verified` も確かめる。
 * 4. ID トークンの `nonce` で `nonceStore` のレコードを取り出して削除し、レコードのトランザクション ID を返す。
 *
 * CSRF の確認は、Google のドキュメントに従って ID トークンの検証より先に行う。
 * `nonce` のレコードは、ID トークンの検証を通ってから消費する。
 * 検証を通らないトークンでレコードを消せると、`nonce` を知っているだけの第三者がログインを妨害できてしまうためである。
 *
 * 結果の `selectBy` は、ボディに `select_by` があるときだけ入る。
 * 呼び出し側は、返したトランザクション ID を core の `getAuthTransaction` に渡し、パスワードによるログインと同じ手順でセッションを確立して同意のステップに進む。
 *
 * @throws {GoogleLoginError} `missing_credential`、`csrf_token_missing_in_cookie`、`csrf_token_missing_in_body`、`csrf_token_mismatch`: ボディか Cookie の値がないか、`g_csrf_token` が一致しないとき
 * @throws {GoogleLoginError} `invalid_id_token`、`signing_key_unavailable`、`invalid_hosted_domain`、`email_not_verified`: ID トークンを受け入れられないとき
 * @throws {GoogleLoginError} `invalid_nonce`、`login_nonce_not_found`、`login_nonce_expired`: `nonce` がないか、`nonce` のレコードがないか期限切れのとき
 */
export async function handleGoogleLoginRedirect(
  context: GoogleLoginRedirectContext,
): Promise<GoogleLoginRedirectResult> {
  const cookieToken = parseGoogleCsrfTokenCookie(context.cookieHeader);
  const credential = parseGoogleRedirectCredential(context.params);
  validateGoogleCsrfToken(credential.csrfToken, cookieToken);

  const account = await verifyGoogleIdToken(credential.credential, {
    clientId: context.clientId,
    verifier: context.verifier,
    hostedDomain: context.hostedDomain,
    requireVerifiedEmail: context.requireVerifiedEmail,
  });

  const nonce = account.nonce;
  if (typeof nonce !== 'string' || nonce.length === 0) {
    throw new GoogleLoginError(
      GoogleLoginErrorCode.InvalidNonce,
      'ID token does not carry the nonce issued for this login page',
    );
  }
  const record = await consumeGoogleLoginNonce(nonce, context.nonceStore, context.now);

  const result: GoogleLoginRedirectResult = {
    transactionId: record.transactionId,
    account,
  };
  if (credential.selectBy !== undefined) {
    result.selectBy = credential.selectBy;
  }
  return result;
}
