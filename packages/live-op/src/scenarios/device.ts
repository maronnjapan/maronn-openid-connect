/**
 * The recipes of the cases of the Device Authorization Grant (RFC 8628)
 * and of CIBA (OpenID Connect CIBA Core 1.0) on the live OP: the device
 * and the call center ask the OP, the user's browser goes through the
 * OP's pages, the client polls the token endpoint. The cases about expiry
 * move the OP's clock past the lifetime the OP gave (`expires_in`).
 */
import { cibaConfig } from '../../../../apps/hono/src/oidc-provider/features/ciba/config.js';
import type { LiveRequest } from '../api.js';
import type { StepResponse } from '../grant.js';
import type { ScenarioContext, ScenarioRecipe } from '../scenario-runtime.js';
import { CASE_USER, CaseBrowser, clientForm, jsonField, requireStatus, type ClientAuth } from './steps.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const CIBA_GRANT = 'urn:openid:params:grant-type:ciba';
/** The public client of the device grant (a TV). */
const DEVICE_PUBLIC = 'device-tv';
/** The confidential client of the device grant (client_secret_post). */
const DEVICE_CONFIDENTIAL = 'device-tv-confidential';
/** The CIBA client (client_secret_basic). */
const CIBA_CLIENT = 'call-center';
/** A client of the code flow, not registered for the device grant. */
const CODE_CLIENT = 'client-2';

/** What the user decides on the OP's page. */
type Decision = 'approve' | 'deny';
/** What happened before the poll of a case: nothing (pending), a poll (slow-down), the user's decision (approve, deny), the approval and a poll that took the tokens (used), or the lifetime the OP gave passing (expired). */
type Poll = Decision | 'pending' | 'slow-down' | 'used' | 'expired';

/** Stop a case whose step the OP did not answer with the OAuth error given. */
function requireError(response: StepResponse, error: string, what: string): void {
  requireStatus(response, 400, what);
  if (jsonField(response, 'error') !== error) throw new Error(`${what}: OP は ${error} を返しませんでした。`);
}

/** A device authorization request of a client (RFC 8628 §3.1) for the scope given, authenticated as the case says. */
function deviceAuthorization(context: ScenarioContext, clientId: string, scope = 'openid profile', auth: ClientAuth = 'registered'): LiveRequest {
  return clientForm(context, '/device_authorization', clientId, { scope }, auth);
}

/** The codes the OP gave the TV for a new device authorization, and their lifetime in seconds. */
async function deviceCodes(context: ScenarioContext): Promise<{ device: string; user: string; completeUrl: string; expiresIn: number }> {
  const response = requireStatus(await context.send(deviceAuthorization(context, DEVICE_PUBLIC)), 200, 'デバイス認可リクエスト');
  const expiresIn = (JSON.parse(response.body) as { expires_in?: unknown }).expires_in;
  if (typeof expiresIn !== 'number') throw new Error('デバイス認可の応答に expires_in がありません。');
  return { device: jsonField(response, 'device_code'), user: jsonField(response, 'user_code'), completeUrl: jsonField(response, 'verification_uri_complete'), expiresIn };
}

/** The user's browser submitting the user code shown on the device (RFC 8628 §3.3). */
function userCodeForm(browser: CaseBrowser, userCode: string): LiveRequest {
  return browser.post('/device', { user_code: userCode });
}

/** The user's browser after submitting a user code: the request that submits the device login form, with the password given. */
async function deviceLogin(context: ScenarioContext, userCode: string, password = CASE_USER.password): Promise<{ browser: CaseBrowser; request: LiveRequest }> {
  const browser = new CaseBrowser(context, { ...CASE_USER, password });
  const page = await browser.send(userCodeForm(browser, userCode), 200, 'ユーザーコードの入力');
  return { browser, request: browser.formOf(page) };
}

/** The user's browser signed in for a user code: the request that submits the approval page with the decision given. */
async function deviceDecision(context: ScenarioContext, userCode: string, decision: Decision): Promise<LiveRequest> {
  const { browser, request } = await deviceLogin(context, userCode);
  const page = await browser.send(request, 200, 'デバイスのログイン');
  return browser.formOf(page, { decision });
}

/** The TV's poll of the token endpoint for a device code (RFC 8628 §3.4), after what the case says happened. */
async function devicePoll(context: ScenarioContext, outcome: Poll): Promise<LiveRequest> {
  const code = await deviceCodes(context);
  const request = clientForm(context, '/token', DEVICE_PUBLIC, { grant_type: DEVICE_GRANT, device_code: code.device });
  if (outcome === 'slow-down') requireError(await context.send(request), 'authorization_pending', '最初のポーリング');
  if (outcome === 'approve' || outcome === 'deny' || outcome === 'used') {
    requireStatus(await context.send(await deviceDecision(context, code.user, outcome === 'deny' ? 'deny' : 'approve')), 200, 'デバイスの承認');
  }
  if (outcome === 'used') requireStatus(await context.send(request), 200, 'トークンの受け取り');
  if (outcome === 'expired') await context.advanceClock(code.expiresIn + 1);
  return request;
}

/** A backchannel authentication request of the call center (CIBA Core 1.0 §7.1) for a user, or for none, authenticated as the case says. */
function cibaAuthorization(context: ScenarioContext, loginHint: string | undefined, auth: ClientAuth = 'registered'): LiveRequest {
  return clientForm(context, '/backchannel_authentication', CIBA_CLIENT, {
    scope: 'openid profile',
    binding_message: 'TV-A1',
    ...(loginHint === undefined ? {} : { login_hint: loginHint }),
  }, auth);
}

/** The user's browser on the authentication device's page (/ciba): the request that submits its login form, with the password given. */
async function cibaLogin(context: ScenarioContext, password = CASE_USER.password): Promise<{ browser: CaseBrowser; request: LiveRequest }> {
  const browser = new CaseBrowser(context, { ...CASE_USER, password });
  return { browser, request: await browser.submitPage('/ciba', {}, 'CIBA の確認画面') };
}

/** The decision forms of the pending requests a /ciba page lists (one form each), as their markup. */
function pendingForms(page: StepResponse): string[] {
  return page.body.match(/<form\b[^>]*action="\/ciba\/approve"[^>]*>[\s\S]*?<\/form>/gi) ?? [];
}

/**
 * Decline, as the user on the authentication device, the pending requests
 * the user's /ciba page lists: always, or only when they are as many as
 * the OP takes for one user (cibaConfig.maxPendingPerSubject). The OP
 * refuses a new request for a user with that many pending, and the cases
 * and the reader share the OP, so the requests they left pending pile up.
 */
async function declinePendingRequests(context: ScenarioContext, always: boolean): Promise<void> {
  const { browser, request } = await cibaLogin(context);
  const page = await browser.send(request, 200, 'CIBA のログイン');
  const forms = pendingForms(page);
  if (!always && forms.length < cibaConfig.maxPendingPerSubject) return;
  for (const markup of forms) await browser.send(browser.formOf({ ...page, body: markup }, { decision: 'deny' }), 200, '保留中の CIBA リクエストの拒否');
}

/**
 * The auth_req_id the OP gave the call center for a new request to the
 * case user, and its lifetime in seconds. When the OP refuses it for the
 * requests the user has pending already (invalid_request), the user
 * declines those first (declinePendingRequests) and the call center asks
 * again.
 */
async function cibaRequest(context: ScenarioContext): Promise<{ id: string; expiresIn: number }> {
  let response = await context.send(cibaAuthorization(context, CASE_USER.username));
  if (response.status === 400 && jsonField(response, 'error') === 'invalid_request') {
    await declinePendingRequests(context, true);
    response = await context.send(cibaAuthorization(context, CASE_USER.username));
  }
  requireStatus(response, 200, 'CIBA の認証リクエスト');
  const expiresIn = (JSON.parse(response.body) as { expires_in?: unknown }).expires_in;
  if (typeof expiresIn !== 'number') throw new Error('CIBA の応答に expires_in がありません。');
  return { id: jsonField(response, 'auth_req_id'), expiresIn };
}

/** The user's browser signed in at /ciba: the request that submits the decision given for one pending request. */
async function cibaDecision(context: ScenarioContext, authReqId: string, decision: Decision): Promise<LiveRequest> {
  const { browser, request } = await cibaLogin(context);
  const page = await browser.send(request, 200, 'CIBA のログイン');
  const markup = pendingForms(page).find((candidate) => candidate.includes(`value="${authReqId}"`));
  if (markup === undefined) throw new Error('保留中の CIBA リクエストの決定フォームがありません。');
  return browser.formOf({ ...page, body: markup }, { decision });
}

/** The call center's poll of the token endpoint for an auth_req_id (CIBA Core 1.0 §10.1), after what the case says happened. */
async function cibaPoll(context: ScenarioContext, outcome: Poll): Promise<LiveRequest> {
  const started = await cibaRequest(context);
  const request = clientForm(context, '/token', CIBA_CLIENT, { grant_type: CIBA_GRANT, auth_req_id: started.id });
  if (outcome === 'slow-down') requireError(await context.send(request), 'authorization_pending', '最初のポーリング');
  if (outcome === 'approve' || outcome === 'deny' || outcome === 'used') {
    requireStatus(await context.send(await cibaDecision(context, started.id, outcome === 'deny' ? 'deny' : 'approve')), 200, 'CIBA の承認');
  }
  if (outcome === 'used') requireStatus(await context.send(request), 200, 'トークンの受け取り');
  if (outcome === 'expired') await context.advanceClock(started.expiresIn + 1);
  return request;
}

export const deviceRecipes: Record<string, ScenarioRecipe> = {
  'device-authorization-public': { request: (context) => deviceAuthorization(context, DEVICE_PUBLIC) },
  'device-authorization-confidential': { request: (context) => deviceAuthorization(context, DEVICE_CONFIDENTIAL) },
  'device-authorization-invalid-client': { request: (context) => deviceAuthorization(context, DEVICE_CONFIDENTIAL, 'openid', 'wrong-secret') },
  'device-authorization-unregistered-grant': { request: (context) => deviceAuthorization(context, CODE_CLIENT) },
  'device-authorization-invalid-scope': { request: (context) => deviceAuthorization(context, DEVICE_PUBLIC, 'openid scope-not-registered') },
  'device-entry': { request: (context) => new CaseBrowser(context).get('/device') },
  'device-entry-prefill': {
    async request(context) {
      const url = new URL((await deviceCodes(context)).completeUrl);
      return new CaseBrowser(context).get(`${url.pathname}${url.search}`);
    },
  },
  'device-code-submit': { request: async (context) => userCodeForm(new CaseBrowser(context), (await deviceCodes(context)).user) },
  // A code the OP never issued (RFC 8628 §6.1 alphabet), as a user who mistyped one would send.
  'device-unknown-code': { request: (context) => userCodeForm(new CaseBrowser(context), 'BCDF-GHJK') },
  'device-login': { request: async (context) => (await deviceLogin(context, (await deviceCodes(context)).user)).request },
  'device-login-retry': { request: async (context) => (await deviceLogin(context, (await deviceCodes(context)).user, 'not-the-password')).request },
  'device-approve': { request: async (context) => deviceDecision(context, (await deviceCodes(context)).user, 'approve') },
  'device-decline': { request: async (context) => deviceDecision(context, (await deviceCodes(context)).user, 'deny') },
  'token-device-pending': { request: (context) => devicePoll(context, 'pending') },
  'token-device-slow-down': { request: (context) => devicePoll(context, 'slow-down') },
  'token-device-approved': { request: (context) => devicePoll(context, 'approve') },
  'token-device-declined': { request: (context) => devicePoll(context, 'deny') },
  'token-device-used': { request: (context) => devicePoll(context, 'used') },
  'token-device-expired': { request: (context) => devicePoll(context, 'expired') },
  'backchannel-authentication-start': {
    // The user's device declines the requests left pending first when the OP would refuse one more (declinePendingRequests).
    async request(context) {
      await declinePendingRequests(context, false);
      return cibaAuthorization(context, CASE_USER.username);
    },
  },
  // A login_hint that names no user of the OP.
  'backchannel-authentication-unknown-user': { request: (context) => cibaAuthorization(context, 'user-not-registered-with-this-provider') },
  'backchannel-authentication-missing-hint': { request: (context) => cibaAuthorization(context, undefined) },
  'backchannel-authentication-invalid-client': { request: (context) => cibaAuthorization(context, CASE_USER.username, 'wrong-secret') },
  'ciba-entry': { request: (context) => new CaseBrowser(context).get('/ciba') },
  'ciba-pending-list': {
    async request(context) {
      await cibaRequest(context);
      const { browser, request } = await cibaLogin(context);
      await browser.send(request, 200, 'CIBA のログイン');
      return browser.get('/ciba');
    },
  },
  'ciba-login': {
    async request(context) {
      await cibaRequest(context);
      return (await cibaLogin(context)).request;
    },
  },
  'ciba-login-retry': { request: async (context) => (await cibaLogin(context, 'not-the-password')).request },
  'ciba-approve': { request: async (context) => cibaDecision(context, (await cibaRequest(context)).id, 'approve') },
  'ciba-decline': { request: async (context) => cibaDecision(context, (await cibaRequest(context)).id, 'deny') },
  'token-ciba-pending': { request: (context) => cibaPoll(context, 'pending') },
  'token-ciba-slow-down': { request: (context) => cibaPoll(context, 'slow-down') },
  'token-ciba-approved': { request: (context) => cibaPoll(context, 'approve') },
  'token-ciba-declined': { request: (context) => cibaPoll(context, 'deny') },
  'token-ciba-used': { request: (context) => cibaPoll(context, 'used') },
  'token-ciba-expired': { request: (context) => cibaPoll(context, 'expired') },
};
