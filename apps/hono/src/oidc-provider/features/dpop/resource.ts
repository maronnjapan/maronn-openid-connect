/**
 * DPoP で束縛したアクセストークンを受け取る保護されたリソース（RFC 9449 §7）。
 *
 * クライアントは、アクセストークンを `Authorization: DPoP <token>` で送り、`ath` を入れた DPoP proof を `DPoP` ヘッダーで添える。
 * 保護されたリソースは、DPoP proof を検査し、アクセストークンがその鍵に束縛されていることを確かめる。
 */
import { DpopError } from './errors.js';

/** `WWW-Authenticate` と `Authorization` の DPoP の認証スキーム（RFC 9449 §7.1）。 */
export const DPOP_AUTHENTICATION_SCHEME = 'DPoP';

/** `WWW-Authenticate: DPoP` のチャレンジの内容。 */
export interface DpopChallenge {
  /** 受け付ける DPoP proof の alg（`algs` パラメータ、空白区切り） */
  algs: readonly string[];
  /** エラーコード（`invalid_token`、`invalid_dpop_proof` など） */
  error?: string;
  /** エラーの説明 */
  errorDescription?: string;
}

/**
 * `Authorization` ヘッダーの値から、DPoP スキームのアクセストークンを返す。
 *
 * スキームは大文字と小文字を区別せずに照合し（RFC 7235 §2.1）、スキームの後ろの空白はいくつあってもすべて飛ばす。
 * DPoP 以外のスキームか、ヘッダーがないときは `undefined` を返す。
 *
 * @spec RFC 9449 §7.1
 * @spec RFC 7235 §2.1
 * @throws {DpopError} `invalid_request`: DPoP スキームなのにトークンがないとき
 */
export function readDpopAuthorization(authorizationHeader: string | null | undefined): string | undefined {
  const match = /^DPoP(?: +(.*))?$/i.exec(authorizationHeader ?? '');
  if (match === null) return undefined;
  const token = match[1] ?? '';
  if (token === '') {
    throw new DpopError('invalid_request', 'The DPoP authorization header has no access token');
  }
  return token;
}

/**
 * 保護されたリソースに提示されたアクセストークンが、提示の仕方に合った鍵に束縛されていることを確かめる。
 *
 * - DPoP スキームで提示した（`proofJkt` がある）ときは、トークンが DPoP の鍵に束縛されていて、その鍵が DPoP proof の鍵と同じでなければならない（RFC 9449 §7.1）。
 * - Bearer で提示した（`proofJkt` が `undefined`）ときは、DPoP の鍵に束縛したトークンを拒否する。束縛したトークンを Bearer として使わせない（RFC 9449 §7.2 の MUST）。
 *
 * @spec RFC 9449 §7.1
 * @spec RFC 9449 §7.2
 * @throws {DpopError} `invalid_token`: 束縛の鍵と提示の仕方が合わないとき
 */
export function validateDpopAccessTokenBinding(boundJkt: string | undefined, proofJkt: string | undefined): void {
  if (proofJkt === undefined) {
    if (boundJkt !== undefined) {
      throw new DpopError('invalid_token', 'A DPoP-bound access token must be presented with the DPoP scheme');
    }
    return;
  }
  if (boundJkt === undefined) {
    throw new DpopError('invalid_token', 'The access token is not bound to a DPoP key');
  }
  if (boundJkt !== proofJkt) {
    throw new DpopError('invalid_token', 'The access token is bound to a different DPoP key');
  }
}

/**
 * `WWW-Authenticate` ヘッダーの DPoP のチャレンジを返す。
 *
 * `algs` に受け付ける alg を並べ、エラーがあれば `error` と `error_description` を付ける。
 * 値はこのディレクトリの検査が決めた固定の文言と alg の名前だけなので、引用符を含まない。
 *
 * @spec RFC 9449 §7.1
 * @spec RFC 6750 §3
 */
export function buildDpopChallenge(challenge: DpopChallenge): string {
  const parameters: string[] = [];
  if (challenge.error !== undefined) parameters.push(`error="${challenge.error}"`);
  if (challenge.errorDescription !== undefined) parameters.push(`error_description="${challenge.errorDescription}"`);
  parameters.push(`algs="${challenge.algs.join(' ')}"`);
  return `${DPOP_AUTHENTICATION_SCHEME} ${parameters.join(', ')}`;
}
