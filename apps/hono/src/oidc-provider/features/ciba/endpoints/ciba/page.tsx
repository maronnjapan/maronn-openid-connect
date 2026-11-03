/** @jsxImportSource hono/jsx */
/**
 * EXPERIMENTAL — CIBA authentication device screens (CIBA Core 1.0 §7.1),
 * screen routing layer.
 *
 * The user signs in at /ciba, reviews the pending requests addressed to them
 * (client, scopes, binding_message) and approves or denies. All three routes of
 * that UI are here; none of them holds logic. The steps of steps/ —
 * prepareCibaDevice(), submitCibaLogin() and submitCibaDecision() — mint the
 * login transaction, check the credentials, list the requests and record the
 * decision, and report what happened as an outcome (one box each of
 * `maronn-oidc graph --detail steps --endpoint ciba`). This file turns each
 * outcome into a screen, with the cookies the outcome carries. To customize
 * the CIBA UI, edit this file or the views in ../../views.tsx; the steps never
 * have to change.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import { Hono } from 'hono';
import { renderErrorPage } from '../../../../pages/errors.js';
import { withCookies } from '../../../../pages/respond.js';
import { renderView } from '../../../../views.js';
import {
  cibaViews,
  type CibaCompletedPageParams,
  type CibaLoginPageParams,
  type CibaPendingRequestsPageParams,
} from '../../views.js';
import type { CibaOutcome } from './outcome.js';
import { prepareCibaDevice } from './steps/prepare-device.js';
import { submitCibaDecision } from './steps/submit-decision.js';
import { submitCibaLogin } from './steps/submit-login.js';

export const cibaPage = new Hono<{ Variables: Record<string, any> }>();

/**
 * 認証デバイスのログインフォームを HTML で返す。
 *
 * ビューは `cibaViews()` で選ぶ（アプリが差し替えたビューか、既定のビュー）。
 */
export function renderCibaLoginPage(c: any, params: CibaLoginPageParams): Response {
  const views = cibaViews(c);
  return renderView(<views.cibaLoginPage {...params} />);
}

/**
 * 保留中のリクエストの承認画面を HTML で返す。
 *
 * ビューは `cibaViews()` で選ぶ（アプリが差し替えたビューか、既定のビュー）。
 * ビューには、リクエストごとの `binding_message` も渡す（CIBA Core 1.0 §7.1）。
 *
 * @spec CIBA Core 1.0 §7.1
 */
export function renderCibaPendingRequestsPage(
  c: any,
  params: CibaPendingRequestsPageParams,
): Response {
  const views = cibaViews(c);
  return renderView(<views.cibaPendingRequestsPage {...params} />);
}

/**
 * 承認か拒否を記録した後の完了画面を HTML で返す。
 *
 * ビューは `cibaViews()` で選ぶ（アプリが差し替えたビューか、既定のビュー）。
 */
export function renderCibaCompletedPage(c: any, params: CibaCompletedPageParams): Response {
  const views = cibaViews(c);
  return renderView(<views.cibaCompletedPage {...params} />);
}

/**
 * ステップの結果に応じた画面で応答する。
 *
 * 結果の種類（`kind`）ごとに、次の画面を返す。
 * - `error`: 結果のステータスコードの OP のエラーページ
 * - `session_required`: ログインし直すよう求める 401 のエラーページ
 * - `invalid_decision`: `invalid_request` を示す 400 のエラーページ
 * - `locked_out`: 試行回数が多すぎることを示す 429 のエラーページ
 * - `login`: ログインフォーム（結果の Cookie を設定する）
 * - `invalid_credentials`: エラーと残りの試行回数を添えたログインフォーム
 * - `pending_requests`: 保留中のリクエストの一覧（結果の Cookie を設定する）
 * - `completed`: 完了画面
 */
function respond(c: any, outcome: CibaOutcome): Response {
  if (outcome.kind === 'error') return renderErrorPage(c, outcome);
  if (outcome.kind === 'session_required') {
    return renderErrorPage(c, {
      error: 'Sign in again to review this request',
      statusCode: 401,
    });
  }
  if (outcome.kind === 'invalid_decision') {
    return renderErrorPage(c, {
      error: 'invalid_request',
      errorDescription: 'decision must be approve or deny',
      statusCode: 400,
    });
  }
  if (outcome.kind === 'locked_out') {
    // ログイントランザクションは削除されているので、このフォームからは再試行できない。
    return renderErrorPage(c, {
      error: 'Too many login attempts',
      statusCode: 429,
    });
  }
  if (outcome.kind === 'login') {
    return withCookies(renderCibaLoginPage(c, {
      loginTransactionId: outcome.loginTransactionId,
      csrfToken: outcome.csrfToken,
    }), outcome.cookies);
  }
  if (outcome.kind === 'invalid_credentials') {
    return renderCibaLoginPage(c, {
      loginTransactionId: outcome.loginTransactionId,
      csrfToken: outcome.csrfToken,
      error: 'Invalid credentials',
      remainingAttempts: outcome.remainingAttempts,
    });
  }
  if (outcome.kind === 'pending_requests') {
    return withCookies(
      renderCibaPendingRequestsPage(c, { requests: outcome.requests }),
      outcome.cookies,
    );
  }
  return renderCibaCompletedPage(c, {
    approved: outcome.approved,
    clientId: outcome.clientId,
  });
}

/**
 * Listing / login form - GET
 *
 * With an OP session: the pending requests addressed to the signed-in user.
 * Without one: the sign-in form, with the binding cookie its submission needs.
 */
cibaPage.get('/', async (c) => respond(c, await prepareCibaDevice(c)));

/** Sign in - POST */
cibaPage.post('/login', async (c) => {
  const body = await c.req.parseBody();
  return respond(c, await submitCibaLogin(c, {
    loginTransactionId: String(body['login_transaction_id'] ?? ''),
    csrfToken: String(body['csrf_token'] ?? ''),
    username: String(body['username'] ?? ''),
    password: String(body['password'] ?? ''),
  }));
});

/** Approve or deny - POST */
cibaPage.post('/approve', async (c) => {
  const body = await c.req.parseBody();
  return respond(c, await submitCibaDecision(c, {
    authReqId: String(body['auth_req_id'] ?? ''),
    csrfToken: String(body['csrf_token'] ?? ''),
    decision: String(body['decision'] ?? ''),
  }));
});
