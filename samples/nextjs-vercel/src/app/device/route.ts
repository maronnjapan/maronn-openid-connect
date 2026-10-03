/**
 * EXPERIMENTAL — device verification UI, step 1 (RFC 8628 §3.3).
 *
 * The End-User opens /device on a second device and types the user_code the
 * first device shows. On a match this step binds the verification to this
 * browser: the user_code is known to whoever started the flow — possibly an
 * attacker — so a CSRF token on the record alone would be no defense. The
 * binding cookie minted here is what every later step requires (see
 * buildDeviceBindingCookie() in store.ts for the full model).
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import type { NextRequest } from 'next/server';
import {
  findPendingRecordByUserCode,
  issueVerificationBinding,
  type DeviceAuthorizationRecord,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { deviceAuthorizationStore, stores } from '../_oidc-provider/provider';
import { buildDeviceBindingCookie, parseSessionId } from '../_oidc-provider/store';
import { readFormFields } from '../_oidc-provider/html';
import {
  approvalScreen,
  invalidUserCodeScreen,
  loginScreen,
  verificationScreen,
} from './screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The user_code entry form (RFC 8628 §3.3 / §3.3.1). Unauthenticated and free
 * of side effects: a user_code in the query (verification_uri_complete) only
 * pre-fills the field, so following the complete URI consumes or reveals
 * nothing.
 */
export function GET(request: NextRequest): Response {
  return verificationScreen(request.nextUrl.searchParams.get('user_code') ?? '');
}

/** User code submission: on a match, the sign-in form or — signed in already — the approval screen. */
export async function POST(request: Request): Promise<Response> {
  const form = await readFormFields(request);
  const submittedUserCode = String(form.get('user_code') ?? '');

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceAuthorizationStore);
  if (!record) {
    return invalidUserCodeScreen(submittedUserCode);
  }

  // Rotate the binding secret and the csrf token together. A second browser
  // submitting the same user_code takes the binding over (last writer wins);
  // that is inherent to a flow whose identifier is shareable by design.
  const { bindingSecret, csrfToken } = await issueVerificationBinding(
    record,
    deviceAuthorizationStore,
  );
  const bindingCookie = buildDeviceBindingCookie(
    record.userCode,
    bindingSecret,
    remainingTtlSeconds(record),
  );

  const sessionId = parseSessionId(request.headers.get('Cookie'));
  const session = sessionId ? await stores.browserSessionStore.get(sessionId) : undefined;
  if (session) {
    return approvalScreen(
      {
        userCode: record.userCodeDisplay,
        csrfToken,
        clientId: record.clientId,
        scopes: record.scope,
      },
      [bindingCookie],
    );
  }
  return loginScreen({ userCode: record.userCodeDisplay, csrfToken }, [bindingCookie]);
}

/**
 * Remaining lifetime of a record in whole seconds, rounded up so the binding
 * cookie always outlives the record it binds (a cookie that expired first
 * would turn a still-valid verification into an unexplained 403).
 */
function remainingTtlSeconds(record: DeviceAuthorizationRecord): number {
  return Math.max(0, Math.ceil((record.expiresAt.getTime() - Date.now()) / 1000));
}
