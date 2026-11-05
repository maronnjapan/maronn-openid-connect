/** @jsxImportSource hono/jsx */
/**
 * EXPERIMENTAL — Device Authorization Grant verification screens
 * (RFC 8628 §3.3), screen routing layer.
 *
 * The end user opens /device on a second device, types the user_code the first
 * device is showing, signs in, and approves or denies. All four routes of that
 * UI are here; none of them holds logic. The steps of steps/ —
 * submitDeviceUserCode(), submitDeviceLogin() and submitDeviceDecision() —
 * match the code, mint the browser binding, check the credentials and record
 * the decision, and report what happened as an outcome (one box each of
 * `maronn-oidc graph --detail steps --endpoint device`). This file turns each
 * outcome into a screen, with the cookies the outcome carries. To customize
 * the device UI, edit this file or the views in ../../views.tsx; the steps
 * never have to change.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import { WebRouter } from '../../../../web-router.js';
import { INVALID_USER_CODE_MESSAGE } from '@maronn-openid-connect/experimental/device-authorization-grant';
import { renderErrorPage } from '../../../../pages/errors.js';
import { withCookies } from '../../../../pages/respond.js';
import { renderView } from '../../../../views.js';
import {
  deviceViews,
  type DeviceApprovalPageParams,
  type DeviceCompletedPageParams,
  type DeviceLoginPageParams,
  type DeviceVerificationPageParams,
} from '../../views.js';
import type { DeviceOutcome } from './outcome.js';
import { submitDeviceDecision } from './steps/submit-decision.js';
import { submitDeviceLogin } from './steps/submit-login.js';
import { submitDeviceUserCode } from './steps/submit-user-code.js';

export const devicePage = new WebRouter();

/**
 * ユーザーコードの入力フォームを HTML で返す。
 *
 * ビューは `deviceViews()` で選ぶ（アプリが差し替えたビューか、既定のビュー）。
 *
 * @spec RFC 8628 §3.3
 */
export function renderDeviceVerificationPage(
  c: any,
  params: DeviceVerificationPageParams,
): Response {
  const views = deviceViews(c);
  return renderView(<views.deviceVerificationPage {...params} />);
}

/**
 * 入力フォームを、照合に失敗した旨を添えて 400 で返す。
 *
 * 入力欄には `userCode` を残し、失敗の文言には `INVALID_USER_CODE_MESSAGE` を使う。
 * 文言は、未知のコード、期限切れのコード、使用済みのコードのどれでも同じで、理由を示さない。
 * 区別できると、応答そのものからどのコードが存在するかがわかってしまうためである（RFC 8628 §5.1）。
 *
 * @spec RFC 8628 §5.1
 */
export function renderInvalidUserCode(c: any, userCode: string): Response {
  const views = deviceViews(c);
  return renderView(
    <views.deviceVerificationPage userCode={userCode} error={INVALID_USER_CODE_MESSAGE} />,
    { status: 400 },
  );
}

/**
 * デバイスフローのログインフォームを HTML で返す。
 *
 * ビューは `deviceViews()` で選ぶ（アプリが差し替えたビューか、既定のビュー）。
 */
export function renderDeviceLoginPage(c: any, params: DeviceLoginPageParams): Response {
  const views = deviceViews(c);
  return renderView(<views.deviceLoginPage {...params} />);
}

/**
 * 承認と拒否の画面を HTML で返す。
 *
 * ビューは `deviceViews()` で選ぶ（アプリが差し替えたビューか、既定のビュー）。
 * 既定のビューは、デバイスの表示と見比べられるよう、ユーザーコードをもう一度表示する（RFC 8628 §5.4）。
 *
 * @spec RFC 8628 §5.4
 */
export function renderDeviceApprovalPage(c: any, params: DeviceApprovalPageParams): Response {
  const views = deviceViews(c);
  return renderView(<views.deviceApprovalPage {...params} />);
}

/**
 * デバイスに戻るよう伝える完了画面を HTML で返す。
 *
 * ビューは `deviceViews()` で選ぶ（アプリが差し替えたビューか、既定のビュー）。
 */
export function renderDeviceCompletedPage(c: any, params: DeviceCompletedPageParams): Response {
  const views = deviceViews(c);
  return renderView(<views.deviceCompletedPage {...params} />);
}

/**
 * ステップの結果に応じた画面で応答する。
 *
 * 結果の種類（`kind`）ごとに、次の画面を返す。
 * - `invalid_user_code`: 照合に失敗した旨を添えた 400 の入力フォーム
 * - `error`: 結果のステータスコードの OP のエラーページ
 * - `session_required`: ログインし直すよう求める 401 のエラーページ
 * - `locked_out`: 試行回数が多すぎることを示す 429 のエラーページ
 * - `login`: ログインフォーム（結果の Cookie を設定する）
 * - `invalid_credentials`: エラーと残りの試行回数を添えたログインフォーム
 * - `approval`: 承認と拒否の画面（結果の Cookie を設定する）
 * - `completed`: 完了画面（結果の Cookie を設定する）
 */
function respond(c: any, outcome: DeviceOutcome): Response {
  if (outcome.kind === 'invalid_user_code') return renderInvalidUserCode(c, outcome.userCode);
  if (outcome.kind === 'error') return renderErrorPage(c, outcome);
  if (outcome.kind === 'session_required') {
    return renderErrorPage(c, {
      error: 'Sign in again to approve this device',
      statusCode: 401,
    });
  }
  if (outcome.kind === 'locked_out') {
    // レコードは拒否の状態になったので、デバイスは次のポーリングで `access_denied` を受け取る。
    return renderErrorPage(c, {
      error: 'Too many login attempts',
      statusCode: 429,
    });
  }
  if (outcome.kind === 'login') {
    return withCookies(renderDeviceLoginPage(c, {
      userCode: outcome.userCode,
      csrfToken: outcome.csrfToken,
    }), outcome.cookies);
  }
  if (outcome.kind === 'invalid_credentials') {
    return renderDeviceLoginPage(c, {
      userCode: outcome.userCode,
      csrfToken: outcome.csrfToken,
      error: 'Invalid credentials',
      remainingAttempts: outcome.remainingAttempts,
    });
  }
  if (outcome.kind === 'approval') {
    return withCookies(renderDeviceApprovalPage(c, {
      userCode: outcome.userCode,
      csrfToken: outcome.csrfToken,
      clientId: outcome.clientId,
      scopes: outcome.scopes,
    }), outcome.cookies);
  }
  return withCookies(renderDeviceCompletedPage(c, {
    approved: outcome.approved,
    clientId: outcome.clientId,
  }), outcome.cookies);
}

/**
 * User code entry form - GET
 * RFC 8628 §3.3 / §3.3.1
 *
 * Unauthenticated and side-effect free. A user_code in the query string
 * (verification_uri_complete) only pre-fills the field: nothing is looked up or
 * mutated until the form is submitted, so following the complete URI never
 * consumes or reveals anything.
 */
devicePage.get('/', (c) =>
  renderDeviceVerificationPage(c, { userCode: c.req.query('user_code') ?? '' }),
);

/** User code submission - POST (RFC 8628 §3.3) */
devicePage.post('/', async (c) => {
  const body = await c.req.parseBody();
  return respond(c, await submitDeviceUserCode(c, String(body['user_code'] ?? '')));
});

/** Device login - POST (RFC 8628 §3.3) */
devicePage.post('/login', async (c) => {
  const body = await c.req.parseBody();
  return respond(c, await submitDeviceLogin(c, {
    userCode: String(body['user_code'] ?? ''),
    csrfToken: String(body['csrf_token'] ?? ''),
    username: String(body['username'] ?? ''),
    password: String(body['password'] ?? ''),
  }));
});

/** Approve or deny - POST (RFC 8628 §3.3) */
devicePage.post('/approve', async (c) => {
  const body = await c.req.parseBody();
  return respond(c, await submitDeviceDecision(c, {
    userCode: String(body['user_code'] ?? ''),
    csrfToken: String(body['csrf_token'] ?? ''),
    decision: String(body['decision'] ?? ''),
  }));
});
