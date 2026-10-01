/**
 * EXPERIMENTAL — Device Authorization Grant verification screens
 * (RFC 8628 §3.3), screen routing layer.
 *
 * GET /device renders the user_code entry form. Everything that changes state —
 * matching the code, minting the browser binding, signing in, approving — is
 * routes/device.ts, which renders its screens through the helpers below. To
 * customize the device UI, edit this file or the device* views in views.ts;
 * routes/device.ts never has to change.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import { WebRouter } from '../web-router';
import { INVALID_USER_CODE_MESSAGE } from '@maronn-openid-connect/experimental/device-authorization-grant';
import {
  defaultViews,
  renderView,
  type DeviceApprovalPageParams,
  type DeviceCompletedPageParams,
  type DeviceLoginPageParams,
  type DeviceVerificationPageParams,
} from '../views';

export const devicePage = new WebRouter();

/** Render the user_code entry form (RFC 8628 §3.3). */
export function renderDeviceVerificationPage(
  c: any,
  params: DeviceVerificationPageParams,
): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.deviceVerificationPage(params));
}

/**
 * Re-render the code entry form with the single, reason-free failure message.
 *
 * RFC 8628 §5.1: unknown, expired and already-used codes must be
 * indistinguishable, otherwise the response itself confirms which codes exist.
 */
export function renderInvalidUserCode(c: any, userCode: string): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(
    views.deviceVerificationPage({ userCode, error: INVALID_USER_CODE_MESSAGE }),
    { status: 400 },
  );
}

/** Render the sign-in form of the device flow. */
export function renderDeviceLoginPage(c: any, params: DeviceLoginPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.deviceLoginPage(params));
}

/** Render the approve / deny screen (RFC 8628 §5.4: the user_code is repeated). */
export function renderDeviceApprovalPage(c: any, params: DeviceApprovalPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.deviceApprovalPage(params));
}

/** Render the "go back to your device" screen. */
export function renderDeviceCompletedPage(c: any, params: DeviceCompletedPageParams): Response {
  const views = c.get('views') ?? defaultViews;
  return renderView(views.deviceCompletedPage(params));
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
