/**
 * EXTENSION (dpop): the checks of a protected resource that accepts
 * DPoP-bound access tokens (RFC 9449 §7), which the UserInfo endpoint calls.
 *
 * DPoP で束縛したアクセストークンを受け取る保護されたリソース（RFC 9449 §7）。
 *
 * クライアントは、アクセストークンを `Authorization: DPoP <token>` で送り、`ath` を入れた DPoP proof を `DPoP` ヘッダーで添える。
 * 保護されたリソースは、DPoP proof を検査し、アクセストークンがその鍵に束縛されていることを確かめる（RFC 9449 §7.1）。
 * DPoP の鍵に束縛したアクセストークンは、Bearer として提示されても受け付けない（RFC 9449 §7.2）。
 * 失敗の応答には、Bearer のチャレンジと並べて DPoP のチャレンジを返し、Bearer と DPoP の両方でトークンを送ったリクエストは拒否する（RFC 9449 §7.2）。
 */
import type { UserInfoChallenge } from '../../endpoints/userinfo/response.js';
import { DpopError } from './errors.js';

/** `Authorization` と `WWW-Authenticate` の DPoP の認証スキームの名前（RFC 9449 §7.1）。 */
export const DPOP_AUTHENTICATION_SCHEME = 'DPoP';

/** RFC 9110 §11.2 の token68（RFC 9449 Figure 12）。 */
const TOKEN68 = /^[A-Za-z0-9\-._~+/]+=*$/;

/**
 * `Authorization` ヘッダーの値が DPoP の認証スキームなら、スキームの後ろの値（credentials）を返す。
 *
 * スキームは大文字と小文字を区別せずに照合し（RFC 9110 §11.1）、スキームの後ろの空白はいくつあってもすべて飛ばす。
 * スキームの後ろに何もなければ空文字を返す。
 * DPoP 以外のスキームか、ヘッダーがないときは `undefined` を返す。
 * 返す値がアクセストークンの形をしていることは、`validateDpopCredentials()` が確かめる。
 *
 * @spec RFC 9449 §7.1
 * @spec RFC 9110 §11.1
 */
export function readDpopAuthorization(authorizationHeader: string | null | undefined): string | undefined {
  const match = /^DPoP(?: +(.*))?$/i.exec(authorizationHeader ?? '');
  if (match === null) return undefined;
  return match[1] ?? '';
}

/**
 * `Authorization` ヘッダーの値が、Bearer と DPoP の両方の認証スキームを名指しているかを返す。
 *
 * `Authorization` のフィールドを二つ送ったリクエスト（RFC 9449 Figure 19）は、Fetch の `Headers` では、二つの値をコンマと空白でつないだ一つの値になる（RFC 9110 §5.3）。
 * 値をコンマで区切り、要素ごとに先頭の語を認証スキームとして大文字と小文字を区別せずに読んで、Bearer と DPoP の両方があれば true を返す。
 * 同じスキームを二つ並べた値や、ほかのスキームとの組み合わせには false を返す。
 *
 * @spec RFC 9449 §7.2
 * @spec RFC 9110 §5.3
 */
export function namesBearerAndDpopSchemes(authorizationHeader: string | null | undefined): boolean {
  const schemes = (authorizationHeader ?? '').split(',').map((element) => element.trim().split(/\s+/, 1)[0]?.toLowerCase());
  return schemes.includes('bearer') && schemes.includes('dpop');
}

/**
 * DPoP の認証スキームの credentials がアクセストークンを一つの token68 で持つことを確かめ、そのアクセストークンを返す。
 *
 * DPoP の credentials は `"DPoP" 1*SP token68` である（RFC 9449 Figure 12）。
 * 空白やコンマを含む値（二つのスキームを並べた `Authorization` など）は token68 ではないので拒否する。
 *
 * @spec RFC 9449 §7.1
 * @spec RFC 9110 §11.2
 * @throws {DpopError} `invalid_request`: credentials が空のとき、token68 でないとき
 */
export function validateDpopCredentials(credentials: string): string {
  if (credentials === '') {
    throw new DpopError('invalid_request', 'The DPoP authorization header has no access token');
  }
  if (!TOKEN68.test(credentials)) {
    throw new DpopError('invalid_request', 'The access token of the DPoP authorization header is not a token68 value');
  }
  return credentials;
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
 * 受け付ける DPoP proof の alg を `algs` パラメータに並べた、DPoP のチャレンジを返す。
 *
 * `algs` は alg の名前を空白で区切って並べる（RFC 9449 §7.1 の SHOULD）。
 * 受け付ける alg が一つもなければ、`algs` パラメータを付けない。
 * エラーの情報は、チャレンジを並べる側（`userInfoChallengeHeader()`）が後ろに足す。
 *
 * @spec RFC 9449 §7.1
 */
export function dpopChallengeOf(algs: readonly string[]): UserInfoChallenge {
  return { scheme: DPOP_AUTHENTICATION_SCHEME, parameters: algs.length === 0 ? [] : [`algs="${algs.join(' ')}"`] };
}
