/**
 * EXPERIMENTAL — end_session_endpoint (OpenID Connect RP-Initiated Logout 1.0).
 *
 * Generated because the OP was created with `--enable rp-initiated-logout`.
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may change in a
 * breaking way between releases. Do not build production code on it without
 * pinning the version.
 *
 * The RP sends the user agent here (GET or POST, §2 MUST) to end the OP browser
 * session. A request whose id_token_hint verifies against this OP's keys AND
 * matches the current session's End-User logs out immediately; every other
 * request — no hint, an invalid or expired hint, a client_id that mismatches the
 * hint audience, no session, another user's session — falls to one shared
 * confirmation screen (§2 MUST; §7: an unauthenticated logout link would
 * otherwise be a denial-of-service primitive). The failure reason is never
 * disclosed: it would turn this endpoint into an oracle for session state.
 *
 * ## Why the confirmation needs a cookie + token pair
 *
 * Approving the confirmation ends a session, so a forged cross-site POST must
 * not drive it. The confirmation screen hands this browser a fresh secret
 * twice: in an HttpOnly cookie and in the form's hidden csrf_token, and
 * /logout/approve runs only when both come back equal. The cookie also carries
 * the OP-computed post-logout redirect, so the id_token_hint is never
 * round-tripped through the HTML page.
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  decideLogoutFlow,
  extractIdTokenHintAudience,
  parseEndSessionRequest,
  resolvePostLogoutRedirect,
} from '@maronn-openid-connect/experimental/rp-initiated-logout';
import { IdTokenHintError, generateRandomString, validateIdTokenHint } from '@maronn-openid-connect/core';
import { readFormFields } from '../../_oidc-provider/http';
import {
  config,
  idTokenHintJwks,
  loadSigningKeys,
  stores,
} from '../../_oidc-provider/provider';
import { buildClearedSessionCookie, parseSessionId } from '../../_oidc-provider/cookies';
import { buildLogoutConfirmationCookie } from '../../_oidc-provider/features/rp-initiated-logout/cookies';
import { rpInitiatedLogoutConfig } from '../../_oidc-provider/features/rp-initiated-logout/config';
import { completedScreen, confirmationScreen } from './screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * クエリを `endSession()` に渡し、その応答を返す。
 *
 * `GET /logout` で送られたログアウトの要求を処理する。
 * 応答は、すぐにログアウトした結果（リダイレクトか完了画面）か、ログアウトの確認画面である。
 */
export async function GET(request: NextRequest): Promise<Response> {
  return endSession(request, request.nextUrl.searchParams);
}

/**
 * ボディを `endSession()` に渡し、その応答を返す。
 *
 * `POST /logout` では、GET のクエリと同じパラメータが `application/x-www-form-urlencoded` のボディで届く（RP-Initiated Logout 1.0 §2）。
 * ボディの値のうち文字列だけを `URLSearchParams` に移して渡す。
 */
export async function POST(request: Request): Promise<Response> {
  const params = new URLSearchParams();
  for (const [name, value] of await readFormFields(request)) {
    if (typeof value === 'string') params.append(name, value);
  }
  return endSession(request, params);
}

/**
 * `id_token_hint` を検証し、ログアウトか確認画面を返す。
 *
 * `id_token_hint` が OP の鍵で検証でき（`client_id` が送られたときは、その値がヒントの `aud` に含まれ）、現在の OP のセッションのエンドユーザーを示すときは、すぐにログアウトする。
 * OP のセッションを削除してその Cookie を消し、リダイレクト先があればそこへ 302 でリダイレクトし、なければログアウトの完了画面を返す。
 * リダイレクト先は、要求された `post_logout_redirect_uri` が、ヒントのクライアントの登録した値と完全に一致するときだけ決まり、`state` を付ける。
 *
 * それ以外の要求には、何も削除せずに、新しい確認の Cookie を付けたログアウトの確認画面を返す。
 * 確認の Cookie には、確認画面の `csrf_token` と一致する必要のあるシークレットと、同じリダイレクト先を入れる。
 * `POST /logout/approve` は承認のあとにこのリダイレクト先を使う。
 *
 * ヒントを検証する鍵を読み込めなかったときは、確認画面に回さずにエラーをそのまま投げる。
 *
 * @spec RP-Initiated Logout 1.0 §2
 * @spec RP-Initiated Logout 1.0 §3
 */
async function endSession(request: Request, params: URLSearchParams): Promise<Response> {
  const endSessionRequest = parseEndSessionRequest(params);
  // `logout_hint` と `ui_locales` は受け付けるが使わない（どちらも任意のパラメータ。RP-Initiated Logout 1.0 §2）。
  // `logout_hint` はエンドユーザーを特定しうるので、解析したあとは読まず、ログにも出さない。
  // `id_token_hint` の値そのものもログに出さない。

  // ヒントの署名、`iss`、`aud`、`exp` などを、ほかの場所で `id_token_hint` を検証するのと同じ鍵（OP が ID トークンの署名に使う鍵）で検証する（RP-Initiated Logout 1.0 §2）。
  // 期待するオーディエンスは、`client_id` パラメータがあればその値、なければヒントのペイロードから検証せずに取り出した値である。
  // 取り出した値を信頼できるのは、そのあとの `validateIdTokenHint()` を通ってからである。
  let verifiedHint: { sub: string; [key: string]: unknown } | null = null;
  let expectedAudience: string | null = null;
  if (endSessionRequest.idTokenHint !== undefined) {
    expectedAudience =
      endSessionRequest.clientId ?? extractIdTokenHintAudience(endSessionRequest.idTokenHint);
    if (expectedAudience !== null) {
      try {
        verifiedHint = await validateIdTokenHint(endSessionRequest.idTokenHint, {
          expectedIss: config.issuer,
          expectedAud: expectedAudience,
          jwks: await idTokenHintJwks(await loadSigningKeys()),
        });
      } catch (error) {
        // 期限切れ、改ざん、ほかの発行者のヒントは、エラーとして報告しない。
        // ログアウトの権限を示せなかっただけなので、理由を明かさずに確認画面の経路に回す（RP-Initiated Logout 1.0 §2 の MUST）。
        // ヒントの検証の失敗（`IdTokenHintError`）以外のエラー（鍵の読み込みの失敗など）は投げ直す。
        // 障害を「無効なヒント」として隠すと、すべてのログアウトが気付かれないまま確認画面に変わってしまうためである。
        if (!(error instanceof IdTokenHintError)) throw error;
        verifiedHint = null;
      }
    }
  }

  const sessionId = parseSessionId(request.headers.get('Cookie'));
  const session = sessionId ? await stores.browserSessionStore.get(sessionId) : undefined;

  const decision = decideLogoutFlow({
    verifiedHint,
    expectedAudience,
    clientIdParam: endSessionRequest.clientId,
    sessionSubject: session ? session.subject : null,
  });

  // 検証できたクライアントが登録した URI と完全に一致するときだけ、`state` を付けてリダイレクト先にする（RP-Initiated Logout 1.0 §3）。
  // 確認画面の経路でも承認のあとに同じ結果を使うので、分岐より前に決める。
  // リダイレクトするかどうかはヒントと完全一致だけで決まり、どちらの経路でログアウトしたかには左右されない。
  const redirectTo = resolvePostLogoutRedirect({
    postLogoutRedirectUri: endSessionRequest.postLogoutRedirectUri,
    state: endSessionRequest.state,
    verifiedClientId: decision.verifiedClientId,
    registeredUris:
      decision.verifiedClientId === null
        ? []
        : rpInitiatedLogoutConfig.postLogoutRedirectUris[decision.verifiedClientId] ?? [],
  });

  if (decision.requiresConfirmation) {
    // 先にエンドユーザーに確認する（RP-Initiated Logout 1.0 §2 の MUST）。
    // ここでは何も削除せず、画面の文言もセッションの状態によって変えない。
    // 新しく作ったシークレットを `HttpOnly` の Cookie とフォームの隠しフィールドの `csrf_token` の両方に入れ、リダイレクト先は Cookie に入れる。
    const csrfSecret = generateRandomString(32);
    return confirmationScreen(csrfSecret, [buildLogoutConfirmationCookie({ csrfSecret, redirectTo })]);
  }

  // 現在のセッションのエンドユーザーを示す有効なヒントがあるので、すぐにログアウトする（RP-Initiated Logout 1.0 §2）。
  // ストアのセッションを削除し、同時に Cookie も期限切れにする。
  if (sessionId) {
    await stores.browserSessionStore.delete(sessionId);
  }
  const cookies = [buildClearedSessionCookie()];
  if (redirectTo !== null) {
    const response = NextResponse.redirect(redirectTo, 302);
    for (const cookie of cookies) response.headers.append('Set-Cookie', cookie);
    return response;
  }
  return completedScreen(cookies);
}
