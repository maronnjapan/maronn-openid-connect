/**
 * EXPERIMENTAL — OpenID Connect Client-Initiated Backchannel Authentication
 * (CIBA Core 1.0), authentication device UI — API layer: logic only.
 *
 * This module was generated because the OP was created with `--enable ciba`.
 * It is backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may
 * change in a breaking way between releases. Do not build production code on it
 * without pinning the version.
 *
 * CIBA Core leaves the authentication device — how the user is reached and how
 * they authenticate — outside the specification (§7.1). This UI implements it
 * as an OP-hosted browser page the user visits themselves: sign in at /ciba,
 * review the pending requests addressed to you (client, scopes,
 * binding_message), and approve or deny. The consumption device learns the
 * outcome only by polling the token endpoint — there is no push channel in
 * poll mode.
 *
 * The three steps of steps/ are the three steps of that UI. None of them
 * builds a Response: each returns an outcome (which screen comes next, with
 * which cookies), and page.tsx — which owns the GET and POST routes — turns it
 * into HTTP.
 *
 * ## Why the login form demands a binding cookie
 *
 * A successful login establishes an OP session, whose reach goes beyond CIBA
 * (SSO, prompt=none). A hidden csrf_token alone cannot stop login CSRF: the
 * attacker fetches their own login form, reads a valid transaction id + token
 * pair, and embeds both in a forged cross-site POST — planting the attacker's
 * session in the victim's browser. The login transaction's binding cookie
 * (minted by prepare-device, hash-stored) is what stops it — see
 * buildCibaLoginBindingCookie() in ../../cookies.ts for the full model.
 *
 * ## Why approve / deny does NOT use a binding cookie
 *
 * The approval is already bound to the authenticated OP session: the record's
 * subject must equal the session subject, and the per-record csrf_token is only
 * ever rendered on the session-gated listing. Knowing an auth_req_id gives an
 * attacker no step to forge.
 */
import { CibaVerificationError, listPendingCibaRequests } from '@maronn-openid-connect/experimental/ciba';
import { resolveGrantableScopes } from '../../../../scopes.js';

/** One pending backchannel authentication request, as the approval screen shows it. */
export interface CibaPendingRequest {
  /** auth_req_id; posted back by the decision form. */
  authReqId: string;
  clientId: string;
  /** Scopes this End-User is asked to grant (already narrowed by the scope policy). */
  scopes: string[];
  /** CIBA Core 1.0 §7.1 binding_message, client-supplied: escape before rendering. */
  bindingMessage?: string;
  expiresInSeconds: number;
  /** Per-record CSRF token; posted back by the decision form. */
  csrfToken: string;
}

/** What a step of the UI decided; page.tsx turns it into the next screen. */
export type CibaOutcome =
  /** A binding or CSRF failure the OP shows on its own error page. */
  | { kind: 'error'; error: string; statusCode: number }
  /** The decision step needs an OP session this browser does not have (401). */
  | { kind: 'session_required' }
  /** decision was neither approve nor deny (400). */
  | { kind: 'invalid_decision' }
  /** recordCibaLoginFailure() discarded the login transaction: no further attempt (429). */
  | { kind: 'locked_out' }
  /** Show the sign-in form; cookies carries the binding its submission needs. */
  | { kind: 'login'; loginTransactionId: string; csrfToken: string; cookies: string[] }
  /** Wrong credentials: show the sign-in form again with the attempts left. */
  | {
      kind: 'invalid_credentials';
      loginTransactionId: string;
      csrfToken: string;
      remainingAttempts: number;
    }
  /** Show the signed-in user's pending requests; cookies carries a new OP session, if any. */
  | { kind: 'pending_requests'; requests: CibaPendingRequest[]; cookies: string[] }
  /** The decision is recorded. */
  | { kind: 'completed'; approved: boolean; clientId: string };

/** The fields of the sign-in form. */
export interface CibaLoginSubmission {
  loginTransactionId: string;
  csrfToken: string;
  username: string;
  password: string;
}

/** The fields of the approve / deny form. */
export interface CibaDecisionSubmission {
  authReqId: string;
  csrfToken: string;
  /** 'approve' or 'deny'. */
  decision: string;
}

/**
 * 検証の失敗を、エラーページに出す結果に変えて返す。
 *
 * `CibaVerificationError`（ログイントランザクションか認証リクエストの検証の失敗）なら、そのメッセージとステータスコード（403）を持つ `error` の結果を返す。
 * それ以外のエラーは、そのまま投げ直す。
 */
export function verificationFailure(error: unknown): CibaOutcome {
  if (error instanceof CibaVerificationError) {
    return { kind: 'error', error: error.message, statusCode: error.statusCode };
  }
  throw error;
}

/**
 * 有効期限（`expiresAt`）までの残りの秒数を返す。
 *
 * 1 秒未満の端数は切り上げ、期限を過ぎていれば 0 を返す。
 * 保留中のリクエストの残り時間の表示と、バインディング Cookie の `Max-Age` に使う。
 */
export function remainingSeconds(expiresAt: Date): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
}

/**
 * 保留中のリクエストを、新しい CSRF トークン付きで返す。
 *
 * `subject` 宛ての保留中のリクエストをストアから取得し、レコードごとに CSRF トークンを作り直して保存したうえで、承認画面に出す形（`CibaPendingRequest`）にして返す。
 * スコープは、`resolveGrantableScopes()`（`scopes.ts`）でこのエンドユーザーに許可できるものだけに絞る。
 * CSRF トークンを渡すのはこの一覧だけで、一覧を返すのは OP のセッションがあるとき（ログインした直後を含む）だけである。
 */
export async function listPendingRequests(c: any, subject: string): Promise<CibaPendingRequest[]> {
  const cibaStore = c.get('cibaAuthenticationRequestStore');
  const pending = await listPendingCibaRequests({ subject, store: cibaStore });
  return Promise.all(
    pending.map(async (record) => ({
      authReqId: record.authReqId,
      clientId: record.clientId,
      // このエンドユーザーが実際に許可できるスコープだけを表示する（`scopes.ts`）。
      scopes: await resolveGrantableScopes(record.scope, subject),
      bindingMessage: record.bindingMessage,
      expiresInSeconds: remainingSeconds(record.expiresAt),
      csrfToken: record.csrfToken ?? '',
    })),
  );
}
