import { cibaConfig } from '../../../../apps/hono/src/oidc-provider/features/ciba/config.js';
import { deviceAuthorizationConfig } from '../../../../apps/hono/src/oidc-provider/features/device-authorization-grant/config.js';
import type { SandboxRequest } from '../api.js';
import { cookieHeaders, keepCookies, submittedForm, type CookieJar } from '../browser-session.js';
import { PREMISES, type PremiseClient, type Premises } from '../premises.js';
import type { ScenarioContext, ScenarioRecipe } from '../scenario-runtime.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const CIBA_GRANT = 'urn:openid:params:grant-type:ciba';
const DEVICE_PUBLIC: PremiseClient = { clientId: 'scenario-tv', authMethod: 'none', redirectUris: [], grantTypes: [DEVICE_GRANT], scope: ['openid', 'profile'] };
const DEVICE_CONFIDENTIAL: PremiseClient = { clientId: 'scenario-tv-confidential', clientSecret: 'scenario-tv-secret', authMethod: 'client_secret_post', redirectUris: [], grantTypes: [DEVICE_GRANT] };
const CIBA_CLIENT: PremiseClient = { clientId: 'scenario-call-center', clientSecret: 'scenario-call-center-secret', authMethod: 'client_secret_basic', redirectUris: [], grantTypes: [CIBA_GRANT] };
const CLIENT_FOR_CODE = PREMISES.clients[1];
const DEMO_USER = PREMISES.users[0];

type Decision = 'approve' | 'deny';
type Poll = Decision | 'pending' | 'slow-down' | 'used';
type ScenarioResponse = Awaited<ReturnType<ScenarioContext['send']>>;

/** A sandbox with the example devices and user registered. */
function plan(now: number): Premises {
  return { ...PREMISES, now, clients: [DEVICE_PUBLIC, DEVICE_CONFIDENTIAL, CIBA_CLIENT, CLIENT_FOR_CODE], grants: [] };
}

/** A GET to the provider, with the browser cookies the previous step obtained. */
function visit(path: string, jar: CookieJar = new Map()): SandboxRequest {
  return { method: 'GET', path, headers: cookieHeaders(jar) };
}

/** A form POST from a client or the browser, with its actual encoded fields. */
function form(path: string, fields: Record<string, string>, headers: SandboxRequest['headers'] = []): SandboxRequest {
  return { method: 'POST', path, headers: [['content-type', 'application/x-www-form-urlencoded'], ...headers], body: new URLSearchParams(fields).toString() };
}

/** A request from a browser that visited or submitted the previous form. */
function browserForm(context: ScenarioContext, path: string, fields: Record<string, string>, jar: CookieJar = new Map()): SandboxRequest {
  return form(path, fields, [['origin', new URL(context.issuer).origin], ...cookieHeaders(jar)]);
}

/** Apply an OP response's cookie changes to the cookies the browser sent. */
function cookies(response: ScenarioResponse, jar: CookieJar = new Map()): CookieJar {
  keepCookies(jar, response.headers.filter(([name]) => name === 'set-cookie').map(([, value]) => value));
  return jar;
}

/** Read the actual fields of the OP's form, including its hidden values. */
function pageForm(response: ScenarioResponse, action: string, password = DEMO_USER.password): Record<string, string> {
  const form = submittedForm(response.body, { username: DEMO_USER.username, password });
  if (form?.action !== action) throw new Error(`The OP did not return the ${action} form at ${response.url}`);
  return Object.fromEntries(form.fields);
}

/** Run one preparation request and stop if the OP responds unexpectedly. */
async function send(context: ScenarioContext, request: SandboxRequest, status = 200, error?: string): Promise<ScenarioResponse> {
  const response = await context.send(request);
  if (response.status !== status || (error !== undefined && JSON.parse(response.body).error !== error)) {
    throw new Error(`Case setup at ${request.path} returned ${response.status} without the expected result`);
  }
  return response;
}

/** Read a generated value that a preparation response returned as JSON. */
function field(response: ScenarioResponse, name: string): string {
  const value: unknown = JSON.parse(response.body)[name];
  if (typeof value !== 'string' || value === '') throw new Error(`The OP did not return ${name} at ${response.url}`);
  return value;
}

/** Ask for a device authorization with the selected device client's credentials. */
function deviceAuthorization(client: PremiseClient, scope = 'openid profile', secret = client.clientSecret): SandboxRequest {
  return form('/device_authorization', { client_id: client.clientId, scope, ...(secret === undefined ? {} : { client_secret: secret }) });
}

/** Start the browser side of a device flow by requesting real codes from the OP. */
async function deviceCodes(context: ScenarioContext): Promise<{ device: string; user: string; completeUrl: string }> {
  const response = await send(context, deviceAuthorization(DEVICE_PUBLIC));
  return { device: field(response, 'device_code'), user: field(response, 'user_code'), completeUrl: field(response, 'verification_uri_complete') };
}

/** Submit the verification code shown to the user. */
function deviceCodeForm(context: ScenarioContext, userCode: string): SandboxRequest {
  return browserForm(context, '/device', { user_code: userCode });
}

/** Obtain the login transaction and build the device browser's sign-in request. */
async function deviceLogin(context: ScenarioContext, userCode: string, password = DEMO_USER.password): Promise<{ request: SandboxRequest; jar: CookieJar }> {
  const page = await send(context, deviceCodeForm(context, userCode));
  const jar = cookies(page);
  return {
    jar,
    request: browserForm(context, '/device/login', pageForm(page, '/device/login', password), jar),
  };
}

/** Sign in as the demo user and build the decision from the approval form. */
async function deviceDecision(context: ScenarioContext, userCode: string, decision: Decision): Promise<SandboxRequest> {
  const login = await deviceLogin(context, userCode);
  const page = await send(context, login.request);
  return browserForm(context, '/device/approve', { ...pageForm(page, '/device/approve'), decision }, cookies(page, login.jar));
}

/** Poll the device authorization after the specified user action or preceding poll. */
async function devicePoll(context: ScenarioContext, outcome: Poll): Promise<SandboxRequest> {
  const code = await deviceCodes(context);
  const request = form('/token', { grant_type: DEVICE_GRANT, device_code: code.device, client_id: DEVICE_PUBLIC.clientId });
  if (outcome === 'slow-down') await send(context, request, 400, 'authorization_pending');
  if (outcome === 'approve' || outcome === 'deny' || outcome === 'used') {
    await send(context, await deviceDecision(context, code.user, outcome === 'deny' ? 'deny' : 'approve'));
  }
  if (outcome === 'used') await send(context, request);
  return request;
}

/** Authenticate the CIBA client with HTTP Basic. */
function cibaAuthorizationHeader(secret = CIBA_CLIENT.clientSecret): [string, string] {
  return ['authorization', `Basic ${btoa(`${CIBA_CLIENT.clientId}:${secret}`)}`];
}

/** Submit a backchannel authentication request with its optional user hint. */
function cibaAuthorization(subject: string | undefined, secret?: string): SandboxRequest {
  return form('/backchannel_authentication', {
    scope: 'openid profile',
    binding_message: 'TV-A1',
    ...(subject === undefined ? {} : { login_hint: subject }),
  }, [cibaAuthorizationHeader(secret)]);
}

/** Start CIBA for the demo user and return the OP's correlation value. */
async function cibaId(context: ScenarioContext): Promise<string> {
  return field(await send(context, cibaAuthorization(DEMO_USER.username)), 'auth_req_id');
}

/** Obtain the authentication-device login form and submit the user's credentials. */
async function cibaLogin(context: ScenarioContext, password = DEMO_USER.password): Promise<SandboxRequest> {
  const page = await send(context, visit('/ciba'));
  return browserForm(context, '/ciba/login', pageForm(page, '/ciba/login', password), cookies(page));
}

/** Sign in and build the decision from the form for this authentication request. */
async function cibaDecision(context: ScenarioContext, authReqId: string, decision: Decision): Promise<SandboxRequest> {
  const page = await send(context, await cibaLogin(context));
  const formHtml = page.body.match(/<form\b[^>]*>[\s\S]*?<\/form>/gi)?.find((markup) => markup.includes(`value="${authReqId}"`));
  if (formHtml === undefined) throw new Error('The pending CIBA request has no decision form');
  return browserForm(context, '/ciba/approve', { ...pageForm({ ...page, body: formHtml }, '/ciba/approve'), decision }, cookies(page));
}

/** Poll CIBA after the specified user action or preceding poll. */
async function cibaPoll(context: ScenarioContext, outcome: Poll): Promise<SandboxRequest> {
  const id = await cibaId(context);
  const request = form('/token', { grant_type: CIBA_GRANT, auth_req_id: id }, [cibaAuthorizationHeader()]);
  if (outcome === 'slow-down') await send(context, request, 400, 'authorization_pending');
  if (outcome === 'approve' || outcome === 'deny' || outcome === 'used') {
    await send(context, await cibaDecision(context, id, outcome === 'deny' ? 'deny' : 'approve'));
  }
  if (outcome === 'used') await send(context, request);
  return request;
}

const requests: Record<string, ScenarioRecipe['request']> = {
  'device-authorization-public': () => deviceAuthorization(DEVICE_PUBLIC),
  'device-authorization-confidential': () => deviceAuthorization(DEVICE_CONFIDENTIAL),
  'device-authorization-invalid-client': () => deviceAuthorization(DEVICE_CONFIDENTIAL, 'openid', 'wrong-secret'),
  'device-authorization-unregistered-grant': () => deviceAuthorization(CLIENT_FOR_CODE),
  'device-authorization-invalid-scope': () => deviceAuthorization(DEVICE_PUBLIC, 'openid scope-not-registered'),
  'device-entry': () => visit('/device'),
  'device-entry-prefill': async (context) => {
    const { completeUrl } = await deviceCodes(context);
    const url = new URL(completeUrl);
    return visit(url.pathname + url.search);
  },
  'device-code-submit': async (context) => deviceCodeForm(context, (await deviceCodes(context)).user),
  'device-unknown-code': (context) => deviceCodeForm(context, 'BCDF-GHJK'),
  'device-login': async (context) => (await deviceLogin(context, (await deviceCodes(context)).user)).request,
  'device-login-retry': async (context) => (await deviceLogin(context, (await deviceCodes(context)).user, 'wrong-password')).request,
  'device-approve': async (context) => deviceDecision(context, (await deviceCodes(context)).user, 'approve'),
  'device-decline': async (context) => deviceDecision(context, (await deviceCodes(context)).user, 'deny'),
  'token-device-pending': (context) => devicePoll(context, 'pending'),
  'token-device-slow-down': (context) => devicePoll(context, 'slow-down'),
  'token-device-approved': (context) => devicePoll(context, 'approve'),
  'token-device-declined': (context) => devicePoll(context, 'deny'),
  'token-device-used': (context) => devicePoll(context, 'used'),
  'backchannel-authentication-start': () => cibaAuthorization(DEMO_USER.username),
  'backchannel-authentication-unknown-user': () => cibaAuthorization('unknown-scenario-user'),
  'backchannel-authentication-missing-hint': () => cibaAuthorization(undefined),
  'backchannel-authentication-invalid-client': () => cibaAuthorization(DEMO_USER.username, 'wrong-secret'),
  'ciba-entry': () => visit('/ciba'),
  'ciba-pending-list': async (context) => {
    await cibaId(context);
    return visit('/ciba', cookies(await send(context, await cibaLogin(context))));
  },
  'ciba-login': async (context) => {
    await cibaId(context);
    return cibaLogin(context);
  },
  'ciba-login-retry': (context) => cibaLogin(context, 'wrong-password'),
  'ciba-approve': async (context) => cibaDecision(context, await cibaId(context), 'approve'),
  'ciba-decline': async (context) => cibaDecision(context, await cibaId(context), 'deny'),
  'token-ciba-pending': (context) => cibaPoll(context, 'pending'),
  'token-ciba-slow-down': (context) => cibaPoll(context, 'slow-down'),
  'token-ciba-approved': (context) => cibaPoll(context, 'approve'),
  'token-ciba-declined': (context) => cibaPoll(context, 'deny'),
  'token-ciba-used': (context) => cibaPoll(context, 'used'),
};

export const deviceRecipes: Record<string, ScenarioRecipe> = {
  ...Object.fromEntries(Object.entries(requests).map(([id, request]) => [id, { plan, request }])),
  'token-device-expired': { plan, request: (context) => devicePoll(context, 'pending'), elapsedSeconds: deviceAuthorizationConfig.deviceCodeExpiresIn + 1 },
  'token-ciba-expired': { plan, request: (context) => cibaPoll(context, 'pending'), elapsedSeconds: cibaConfig.authReqIdExpiresIn + 1 },
};
