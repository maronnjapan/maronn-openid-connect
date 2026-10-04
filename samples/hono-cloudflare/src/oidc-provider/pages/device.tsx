/** @jsxImportSource hono/jsx */
/**
 * EXPERIMENTAL — Device Authorization Grant verification screens
 * (RFC 8628 §3.3), screen routing layer.
 *
 * The end user opens /device on a second device, types the user_code the first
 * device is showing, signs in, and approves or denies. All four routes of that
 * UI are here; none of them holds logic. submitDeviceUserCode(),
 * submitDeviceLogin() and submitDeviceDecision() in routes/device.ts match the
 * code, mint the browser binding, check the credentials and record the
 * decision, and report what happened as an outcome. This file turns each
 * outcome into a screen, with the cookies the outcome carries. To customize
 * the device UI, edit this file or the device* views in views.tsx;
 * routes/device.ts never has to change.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import { Hono } from 'hono';
import { INVALID_USER_CODE_MESSAGE } from '@maronn-openid-connect/experimental/device-authorization-grant';
import {
  submitDeviceDecision,
  submitDeviceLogin,
  submitDeviceUserCode,
  type DeviceOutcome,
} from '../routes/device.js';
import {
  defaultViews,
  renderView,
  type DeviceApprovalPageParams,
  type DeviceCompletedPageParams,
  type DeviceLoginPageParams,
  type DeviceVerificationPageParams,
  type Views,
} from '../views.js';
import { renderErrorPage } from './errors.js';
import { withCookies } from './respond.js';

export const devicePage = new Hono<{ Variables: Record<string, any> }>();

/** Render the user_code entry form (RFC 8628 §3.3). */
export function renderDeviceVerificationPage(
  c: any,
  params: DeviceVerificationPageParams,
): Response {
  const views: Views = c.get('views') ?? defaultViews;
  return renderView(<views.deviceVerificationPage {...params} />);
}

/**
 * Re-render the code entry form with the single, reason-free failure message.
 *
 * RFC 8628 §5.1: unknown, expired and already-used codes must be
 * indistinguishable, otherwise the response itself confirms which codes exist.
 */
export function renderInvalidUserCode(c: any, userCode: string): Response {
  const views: Views = c.get('views') ?? defaultViews;
  return renderView(
    <views.deviceVerificationPage userCode={userCode} error={INVALID_USER_CODE_MESSAGE} />,
    { status: 400 },
  );
}

/** Render the sign-in form of the device flow. */
export function renderDeviceLoginPage(c: any, params: DeviceLoginPageParams): Response {
  const views: Views = c.get('views') ?? defaultViews;
  return renderView(<views.deviceLoginPage {...params} />);
}

/** Render the approve / deny screen (RFC 8628 §5.4: the user_code is repeated). */
export function renderDeviceApprovalPage(c: any, params: DeviceApprovalPageParams): Response {
  const views: Views = c.get('views') ?? defaultViews;
  return renderView(<views.deviceApprovalPage {...params} />);
}

/** Render the "go back to your device" screen. */
export function renderDeviceCompletedPage(c: any, params: DeviceCompletedPageParams): Response {
  const views: Views = c.get('views') ?? defaultViews;
  return renderView(<views.deviceCompletedPage {...params} />);
}

/** Turn the outcome of a verification step into the screen that follows it. */
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
    // The record is now denied: the device gets access_denied on its next poll.
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
