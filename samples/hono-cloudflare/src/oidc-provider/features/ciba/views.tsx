/** @jsxImportSource hono/jsx */
/**
 * EXPERIMENTAL — the views of the CIBA authentication device screens (CIBA
 * Core 1.0 §7.1), in hono/jsx.
 *
 * They are members of Views (views.tsx), added below, so the views option of
 * createApp() / applyOidc() can replace them like the login and consent
 * views. A member left out falls back to the default of this file.
 */
import type { JSX } from 'hono/jsx/jsx-runtime';
import {
  CredentialFields,
  DecisionOutcome,
  FormError,
  Layout,
  ScopeList,
  type Views,
} from '../../views.js';

export interface CibaLoginPageParams {
  /** Login transaction id; carried through as a hidden field. */
  loginTransactionId: string;
  /** CSRF token (must be included as hidden form field) */
  csrfToken: string;
  /** Error message from a previous failed attempt */
  error?: string;
  /** Number of remaining login attempts for this login transaction */
  remainingAttempts?: number;
}

export interface CibaPendingRequestParams {
  /** auth_req_id; carried through as a hidden field of the decision form. */
  authReqId: string;
  /** Client that asked for the backchannel authentication */
  clientId: string;
  /** Scopes the client asked for */
  scopes: string[];
  /**
   * CIBA Core 1.0 §7.1 binding_message: shown so the user can compare it with
   * the message on the consumption device — the visual check that they are
   * approving THEIR transaction and not someone else's. Client-supplied text:
   * it MUST be escaped before rendering.
   */
  bindingMessage?: string;
  /** Seconds until this request expires */
  expiresInSeconds: number;
  /** Per-record CSRF token (must be included as hidden form field) */
  csrfToken: string;
}

export interface CibaPendingRequestsPageParams {
  /** Pending backchannel authentication requests addressed to the signed-in user */
  requests: CibaPendingRequestParams[];
}

export interface CibaCompletedPageParams {
  /** true when the user approved, false when they denied */
  approved: boolean;
  /** Client the decision applied to */
  clientId: string;
}

declare module '../../views.js' {
  interface Views {
    /** EXPERIMENTAL (CIBA Core 1.0): render the sign-in form of the authentication device UI */
    cibaLoginPage?(params: CibaLoginPageParams): ViewResult;
    /** EXPERIMENTAL (CIBA Core 1.0): render the pending-requests approval screen */
    cibaPendingRequestsPage?(params: CibaPendingRequestsPageParams): ViewResult;
    /** EXPERIMENTAL (CIBA Core 1.0): render the decision-recorded screen */
    cibaCompletedPage?(params: CibaCompletedPageParams): ViewResult;
  }
}

/**
 * 認証デバイスのログイン画面を描画する。
 *
 * ユーザー名とパスワードを `/ciba/login` に送るフォームで、隠しフィールドの `login_transaction_id` と `csrf_token` も一緒に送る。
 * 前の試行が失敗していれば、フォームの上にエラーと、わかっていれば残りの試行回数を表示する。
 */
function defaultCibaLoginPage(params: CibaLoginPageParams): JSX.Element {
  return (
    <Layout title="Sign in">
      <h1>Sign in</h1>
      <p>Sign in to review sign-in requests sent to you.</p>
      <FormError error={params.error} remainingAttempts={params.remainingAttempts} />
      <form method="post" action="/ciba/login">
        <input type="hidden" name="login_transaction_id" value={params.loginTransactionId} />
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <CredentialFields />
        <button type="submit">Login</button>
      </form>
    </Layout>
  );
}

/**
 * 保留中のリクエストを承認と拒否のボタン付きで描画する。
 *
 * ログインしているエンドユーザー宛てのリクエストごとに、クライアント、要求されたスコープ、`binding_message`（クライアントが送ったときだけ）、残りの秒数を表示する。
 * 承認と拒否のボタンは、`decision`、`auth_req_id`、`csrf_token` を `/ciba/approve` に送る。
 * リクエストがなければ、保留中のリクエストがないことだけを表示する。
 *
 * @spec CIBA Core 1.0 §7.1
 */
function defaultCibaPendingRequestsPage(params: CibaPendingRequestsPageParams): JSX.Element {
  if (params.requests.length === 0) {
    return (
      <Layout title="Sign-in Requests">
        <h1>Sign-in Requests</h1>
        <p>No pending sign-in requests.</p>
      </Layout>
    );
  }

  // `binding_message` は、ここであえてもう一度表示する（CIBA Core 1.0 §7.1）。
  // 承認する前に、リクエストを始めたデバイスの表示と見比べるようエンドユーザーに促す。
  // 拒否のボタンは、承認のボタンと同じ目立ち方で表示する。
  return (
    <Layout title="Sign-in Requests">
      <h1>Sign-in Requests</h1>
      <p>Only approve a request you started yourself on another device.</p>
      {params.requests.map((request) => (
        <section>
          <p>Client <strong>{request.clientId}</strong> is requesting access to the following scopes:</p>
          <ScopeList scopes={request.scopes} />
          {request.bindingMessage ? (
            <p>Confirm that your device is showing this message: <strong>{request.bindingMessage}</strong></p>
          ) : null}
          <p>This request expires in {request.expiresInSeconds} seconds.</p>
          <form method="post" action="/ciba/approve">
            <input type="hidden" name="auth_req_id" value={request.authReqId} />
            <input type="hidden" name="csrf_token" value={request.csrfToken} />
            <button type="submit" name="decision" value="approve">Approve</button>
            <button type="submit" name="decision" value="deny">Deny</button>
          </form>
        </section>
      ))}
    </Layout>
  );
}

/**
 * 承認か拒否を記録した後の完了画面を描画する。
 *
 * エンドユーザーがクライアントを承認したか拒否したかと、このページを閉じてデバイスに戻ってよいことを表示する。
 */
function defaultCibaCompletedPage(params: CibaCompletedPageParams): JSX.Element {
  return (
    <Layout title="Sign-in Requests">
      <h1>Sign-in Requests</h1>
      <DecisionOutcome approved={params.approved} clientId={params.clientId} />
      <p>You can close this page and go back to your device.</p>
    </Layout>
  );
}

/**
 * 認証デバイスの 3 つの画面のビューを返す。
 *
 * リクエストコンテキストの `views`（アプリが `views` オプションで差し替えたビュー）にあればそれを、なければこのファイルの既定のビューを返す。
 */
export function cibaViews(c: any): Required<Pick<Views, 'cibaLoginPage' | 'cibaPendingRequestsPage' | 'cibaCompletedPage'>> {
  const views: Partial<Views> = c.get('views') ?? {};
  return {
    cibaLoginPage: views.cibaLoginPage ?? defaultCibaLoginPage,
    cibaPendingRequestsPage: views.cibaPendingRequestsPage ?? defaultCibaPendingRequestsPage,
    cibaCompletedPage: views.cibaCompletedPage ?? defaultCibaCompletedPage,
  };
}
