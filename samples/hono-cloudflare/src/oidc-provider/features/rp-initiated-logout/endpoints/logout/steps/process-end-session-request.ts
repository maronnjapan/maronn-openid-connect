import {
  decideLogoutFlow,
  extractIdTokenHintAudience,
  parseEndSessionRequest,
  resolvePostLogoutRedirect,
} from '@maronn-openid-connect/experimental/rp-initiated-logout';
import {
  IdTokenHintError,
  generateRandomString,
  validateIdTokenHint,
} from '@maronn-openid-connect/core';
import { buildClearedSessionCookie, parseSessionId } from '../../../../../cookies.js';
import { buildLogoutConfirmationCookie } from '../../../cookies.js';
import type { LogoutOutcome } from '../outcome.js';
import { step } from '../../../../../endpoints/step.js';
import { rpInitiatedLogoutConfig } from '../../../config.js';
import { idTokenHintJwks } from '../../../../../id-token-hint-jwks.js';

export const meta = step({
  id: 'process-end-session-request',
  endpoint: 'logout',
  feature: 'rp-initiated-logout',
  kind: 'decide',
  label: 'id_token_hint を検証し、確認の要否を決める',
  spec: 'RP-Initiated Logout 1.0 §2 / §3',
  function: 'processEndSessionRequest',
  consumes: [],
  produces: ['confirmation'],
  removable: false,
});

/**
 * `id_token_hint` を検証し、ログアウトか確認画面を返す。
 *
 * `id_token_hint` が OP の鍵で検証でき（`client_id` が送られたときは、その値がヒントの `aud` に含まれ）、現在の OP のセッションのエンドユーザーを示すときは、すぐにログアウトする。
 * OP のセッションを削除し、セッションの Cookie を消す Cookie を付けて、リダイレクト先があれば `redirect`、なければ `completed` を返す。
 * リダイレクト先は、要求された `post_logout_redirect_uri` が、ヒントのクライアントの登録した値と完全に一致するときだけ決まり、`state` を付ける。
 *
 * それ以外の要求には、何も削除せずに、新しい確認の Cookie を付けた `confirmation` を返す。
 * 確認の Cookie には、確認画面の `csrf_token` と一致する必要のあるシークレットと、同じリダイレクト先を入れる。
 * `POST /logout/approve` は承認のあとにこのリダイレクト先を使う。
 *
 * GET と POST はパラメータの読み取り元が違うだけなので、この関数を共有する。
 * ヒントを検証する鍵の集合を取得できなかったときは、確認画面に回さずにエラーをそのまま投げる。
 *
 * @spec RP-Initiated Logout 1.0 §2
 * @spec RP-Initiated Logout 1.0 §3
 */
export async function processEndSessionRequest(c: any, params: URLSearchParams): Promise<LogoutOutcome> {
  const browserSessionStore = c.get('browserSessionStore');
  const config = c.get('config');
  const request = parseEndSessionRequest(params);
  // `logout_hint` と `ui_locales` は受け付けるが使わない（どちらも任意のパラメータ。RP-Initiated Logout 1.0 §2）。
  // `logout_hint` はエンドユーザーを特定しうるので、解析したあとは読まず、ログにも出さない。
  // `id_token_hint` の値そのものもログに出さない。

  // ヒントの署名、`iss`、`aud`、`exp` などを、ほかの場所で `id_token_hint` を検証するのと同じ鍵の集合（リクエストコンテキストの `jwksProvider`）で検証する（RP-Initiated Logout 1.0 §2）。
  // 期待するオーディエンスは、`client_id` パラメータがあればその値、なければヒントのペイロードから検証せずに取り出した値である。
  // 取り出した値を信頼できるのは、そのあとの `validateIdTokenHint()` を通ってからである。
  let verifiedHint: { sub: string; [key: string]: unknown } | null = null;
  let expectedAudience: string | null = null;
  if (request.idTokenHint !== undefined) {
    expectedAudience = request.clientId ?? extractIdTokenHintAudience(request.idTokenHint);
    if (expectedAudience !== null) {
      try {
        const jwks = await idTokenHintJwks(c);
        if (jwks === undefined) throw new Error('ID Token verification keys are not configured');
        verifiedHint = await validateIdTokenHint(request.idTokenHint, {
          expectedIss: config.issuer,
          expectedAud: expectedAudience,
          jwks,
        });
      } catch (error) {
        // 期限切れ、改ざん、ほかの発行者のヒントは、エラーとして報告しない。
        // ログアウトの権限を示せなかっただけなので、理由を明かさずに確認画面の経路に回す（RP-Initiated Logout 1.0 §2 の MUST）。
        // ヒントの検証の失敗（`IdTokenHintError`）以外のエラー（`jwksProvider` そのものの失敗など）は投げ直す。
        // 障害を「無効なヒント」として隠すと、すべてのログアウトが気付かれないまま確認画面に変わってしまうためである。
        if (!(error instanceof IdTokenHintError)) throw error;
        verifiedHint = null;
      }
    }
  }

  const sessionId = parseSessionId(c.req.header('Cookie') ?? null);
  const session = sessionId ? await browserSessionStore.get(sessionId) : undefined;

  const decision = decideLogoutFlow({
    verifiedHint,
    expectedAudience,
    clientIdParam: request.clientId,
    sessionSubject: session ? session.subject : null,
  });

  // 検証できたクライアントが登録した URI と完全に一致するときだけ、`state` を付けてリダイレクト先にする（RP-Initiated Logout 1.0 §3）。
  // 確認画面の経路でも承認のあとに同じ結果を使うので、分岐より前に決める。
  // リダイレクトするかどうかはヒントと完全一致だけで決まり、どちらの経路でログアウトしたかには左右されない。
  const redirectTo = resolvePostLogoutRedirect({
    postLogoutRedirectUri: request.postLogoutRedirectUri,
    state: request.state,
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
    return {
      kind: 'confirmation',
      csrfToken: csrfSecret,
      cookies: [buildLogoutConfirmationCookie({ csrfSecret, redirectTo })],
    };
  }

  // 現在のセッションのエンドユーザーを示す有効なヒントがあるので、すぐにログアウトする（RP-Initiated Logout 1.0 §2）。
  // ストアのセッションを削除し、同時に Cookie も期限切れにする。
  if (sessionId) {
    await browserSessionStore.delete(sessionId);
  }
  const cookies = [buildClearedSessionCookie()];
  if (redirectTo !== null) {
    return { kind: 'redirect', location: redirectTo, cookies };
  }
  return { kind: 'completed', cookies };
}
