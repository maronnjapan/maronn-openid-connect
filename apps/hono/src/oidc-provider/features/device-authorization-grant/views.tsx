/** @jsxImportSource hono/jsx */
/**
 * EXPERIMENTAL — the views of the Device Authorization Grant verification
 * screens (RFC 8628 §3.3), in hono/jsx.
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

export interface DeviceVerificationPageParams {
  /**
   * user_code to pre-fill the input with. Comes from the query string of
   * verification_uri_complete (RFC 8628 §3.3.1) or from the user's own previous
   * submission, so it is untrusted input and MUST be escaped before rendering.
   */
  userCode?: string;
  /**
   * Failure message for a code that did not match. RFC 8628 §5.1: the same text
   * is used for unknown, expired and already-used codes, so do not add detail
   * here — it would tell an attacker which codes exist.
   */
  error?: string;
}

export interface DeviceLoginPageParams {
  /** user_code in display form; carried through as a hidden field. */
  userCode: string;
  /** CSRF token (must be included as hidden form field) */
  csrfToken: string;
  /** Error message from a previous failed attempt */
  error?: string;
  /** Number of remaining login attempts for this device authorization */
  remainingAttempts?: number;
}

export interface DeviceApprovalPageParams {
  /**
   * user_code in display form. RFC 8628 §5.4: show it so the user can compare it
   * with the code on the device screen — that comparison is the only defense
   * against a remote phishing attempt that lured them to approve someone else's
   * device.
   */
  userCode: string;
  /** CSRF token (must be included as hidden form field) */
  csrfToken: string;
  /** Client the device authorization was requested by */
  clientId: string;
  /** Scopes the device asked for */
  scopes: string[];
}

export interface DeviceCompletedPageParams {
  /** true when the user approved, false when they denied */
  approved: boolean;
  /** Client the decision applied to */
  clientId: string;
}

declare module '../../views.js' {
  interface Views {
    /** EXPERIMENTAL (RFC 8628 §3.3): render the user_code entry form */
    deviceVerificationPage?(params: DeviceVerificationPageParams): ViewResult;
    /** EXPERIMENTAL (RFC 8628 §3.3): render the sign-in form for a device flow */
    deviceLoginPage?(params: DeviceLoginPageParams): ViewResult;
    /** EXPERIMENTAL (RFC 8628 §3.3): render the approve / deny screen */
    deviceApprovalPage?(params: DeviceApprovalPageParams): ViewResult;
    /** EXPERIMENTAL (RFC 8628 §3.3): render the "go back to your device" screen */
    deviceCompletedPage?(params: DeviceCompletedPageParams): ViewResult;
  }
}

/**
 * Render the device verification page: a form that posts the user_code the
 * End-User types to /device.
 *
 * The input is pre-filled with userCode when given, and the failure message of
 * a code that did not match is shown above the form.
 *
 * @spec RFC 8628 §3.3
 */
function defaultDeviceVerificationPage(params: DeviceVerificationPageParams): JSX.Element {
  return (
    <Layout title="Device Activation">
      <h1>Device Activation</h1>
      <p>Enter the code shown on your device.</p>
      <FormError error={params.error} />
      <form method="post" action="/device">
        <div>
          <label for="user_code">Code:</label>
          <input type="text" id="user_code" name="user_code" value={params.userCode ?? ''} required />
        </div>
        <button type="submit">Continue</button>
      </form>
    </Layout>
  );
}

/**
 * Render the sign-in page of a device authorization: the user_code being
 * activated, and a username and password form that posts to /device/login with
 * the hidden user_code and csrf_token.
 *
 * The error of a failed attempt is shown above the form, with the attempts
 * left when known.
 *
 * @spec RFC 8628 §3.3
 */
function defaultDeviceLoginPage(params: DeviceLoginPageParams): JSX.Element {
  return (
    <Layout title="Login">
      <h1>Login</h1>
      <p>Activating device code <strong>{params.userCode}</strong></p>
      <FormError error={params.error} remainingAttempts={params.remainingAttempts} />
      <form method="post" action="/device/login">
        <input type="hidden" name="user_code" value={params.userCode} />
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <CredentialFields />
        <button type="submit">Login</button>
      </form>
    </Layout>
  );
}

/**
 * Render the device approval page: the user_code to compare with the one on
 * the device, the client and the scopes it asked for, and Approve and Deny
 * buttons that post the decision, user_code and csrf_token to /device/approve.
 *
 * @spec RFC 8628 §3.3
 * @spec RFC 8628 §5.4
 */
function defaultDeviceApprovalPage(params: DeviceApprovalPageParams): JSX.Element {
  // RFC 8628 §5.4: the code is repeated here on purpose. Ask the user to check it
  // against the device in front of them before approving.
  return (
    <Layout title="Authorize Device">
      <h1>Authorize Device</h1>
      <p>Confirm that your device is showing this code: <strong>{params.userCode}</strong></p>
      <p>Do not continue if the code does not match.</p>
      <p>Client <strong>{params.clientId}</strong> is requesting access to the following scopes:</p>
      <ScopeList scopes={params.scopes} />
      <form method="post" action="/device/approve">
        <input type="hidden" name="user_code" value={params.userCode} />
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <button type="submit" name="decision" value="approve">Approve</button>
        <button type="submit" name="decision" value="deny">Deny</button>
      </form>
    </Layout>
  );
}

/**
 * Render the page shown once the End-User decided on a device authorization:
 * that they approved or denied the client, and that they can go back to their
 * device.
 */
function defaultDeviceCompletedPage(params: DeviceCompletedPageParams): JSX.Element {
  return (
    <Layout title="Device Activation">
      <h1>Device Activation</h1>
      <DecisionOutcome approved={params.approved} clientId={params.clientId} />
      <p>You can close this page and go back to your device.</p>
    </Layout>
  );
}

/** The device views of the request: the ones the app replaced, else the defaults above. */
export function deviceViews(c: any): Required<Pick<Views, 'deviceVerificationPage' | 'deviceLoginPage' | 'deviceApprovalPage' | 'deviceCompletedPage'>> {
  const views: Partial<Views> = c.get('views') ?? {};
  return {
    deviceVerificationPage: views.deviceVerificationPage ?? defaultDeviceVerificationPage,
    deviceLoginPage: views.deviceLoginPage ?? defaultDeviceLoginPage,
    deviceApprovalPage: views.deviceApprovalPage ?? defaultDeviceApprovalPage,
    deviceCompletedPage: views.deviceCompletedPage ?? defaultDeviceCompletedPage,
  };
}
