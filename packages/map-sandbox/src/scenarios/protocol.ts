import { generateRequestScenario } from '../../../test-catalog/src/premises.js';
import type { SandboxRequest } from '../api.js';
import { cookieHeaders } from '../browser-session.js';
import { PREMISES } from '../premises.js';
import type { ScenarioContext, ScenarioRecipe } from '../scenario-runtime.js';
import { consentedBrowser, signedInBrowser } from './interaction.js';

const CLIENT = PREMISES.clients[0];
const CALLBACK = CLIENT.redirectUris[0];
const OTHER_CALLBACK = 'https://rp.example.com/other';

/** Create a form POST with optional client authentication. */
function form(path: string, fields: URLSearchParams, authorization?: string): SandboxRequest {
  const headers: Array<[string, string]> = [['content-type', 'application/x-www-form-urlencoded']];
  if (authorization !== undefined) headers.push(['authorization', authorization]);
  return { method: 'POST', path, headers, body: fields.toString() };
}

/** Create the corresponding authorization GET. */
function authorization(fields: URLSearchParams, headers: SandboxRequest['headers'] = []): SandboxRequest {
  return { method: 'GET', path: `/authorize?${fields}`, headers };
}

/** Generate fresh state, nonce, and PKCE for the configured demo client. */
async function authorizationFields(context: ScenarioContext, changes: Record<string, string> = {}): Promise<URLSearchParams> {
  const { url } = await generateRequestScenario('authorize-code-pkce', {
    issuer: context.issuer, redirectUri: CALLBACK, clientId: CLIENT.clientId,
  });
  const fields = new URL(url).searchParams;
  for (const [key, value] of Object.entries(changes)) fields.set(key, value);
  return fields;
}

/** Configure the demo client to request front-channel tokens. */
function frontChannelPlan(now: number) {
  return {
    ...PREMISES,
    now,
    grants: [],
    clients: [{ ...CLIENT, grantTypes: ['authorization_code', 'implicit'], responseTypes: ['code', 'id_token', 'code id_token'] }],
  };
}

/** Push authorization parameters using the demo client's Basic credentials. */
async function pushedRequest(context: ScenarioContext, { invalidSecret = false, redirectUri = CALLBACK } = {}): Promise<SandboxRequest> {
  const secret = invalidSecret ? 'incorrect-demo-secret' : CLIENT.clientSecret;
  const basic = btoa(`${encodeURIComponent(CLIENT.clientId)}:${encodeURIComponent(secret ?? '')}`);
  const fields = await authorizationFields(context, { redirect_uri: redirectUri });
  return form('/par', fields, `Basic ${basic}`);
}

/** Register a client with specific OAuth client metadata. */
function register(metadata: Record<string, unknown> = {}): SandboxRequest {
  return {
    method: 'POST', path: '/register', headers: [['content-type', 'application/json']],
    body: JSON.stringify({
      client_name: 'Request scenario client',
      redirect_uris: [CALLBACK],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...metadata,
    }),
  };
}

export const protocolRecipes: Record<string, ScenarioRecipe> = {
  'authorize-post': { request: async (context) => form('/authorize', await authorizationFields(context)) },
  'authorize-par': { async request(context) {
    const pushed = await context.send(await pushedRequest(context));
    const { request_uri: requestUri } = JSON.parse(pushed.body) as { request_uri?: string };
    if (pushed.status !== 201 || requestUri === undefined) throw new Error(`PAR did not return request_uri (HTTP ${pushed.status})`);
    return authorization(new URLSearchParams({ client_id: CLIENT.clientId, request_uri: requestUri }));
  } },
  'authorize-par-unknown': { request: () => authorization(new URLSearchParams({ client_id: CLIENT.clientId, request_uri: 'urn:ietf:params:oauth:request_uri:unused-example' })) },
  'authorize-form-post': { request: async (context) => authorization(await authorizationFields(context, { response_mode: 'form_post' })) },
  'authorize-jarm': { request: async (context) => authorization(await authorizationFields(context, { response_mode: 'query.jwt' })) },
  'authorize-implicit': { plan: frontChannelPlan, async request(context) {
    const fields = await authorizationFields(context, { response_type: 'id_token' });
    fields.delete('code_challenge');
    fields.delete('code_challenge_method');
    return authorization(fields);
  } },
  'authorize-hybrid': { plan: frontChannelPlan, request: async (context) => authorization(await authorizationFields(context, { response_type: 'code id_token' })) },
  'authorize-sso': { async request(context) {
    const { browser } = await consentedBrowser(context);
    return authorization(await authorizationFields(context, { prompt: 'none' }), cookieHeaders(browser.cookies));
  } },
  'authorize-silent-consent-required': { async request(context) {
    const { browser } = await signedInBrowser(context);
    return authorization(await authorizationFields(context, { prompt: 'none', scope: 'openid profile' }), cookieHeaders(browser.cookies));
  } },
  'authorize-force-login': { async request(context) {
    const { browser } = await consentedBrowser(context);
    return authorization(await authorizationFields(context, { prompt: 'login' }), cookieHeaders(browser.cookies));
  } },
  'authorize-force-consent': { async request(context) {
    const { browser } = await consentedBrowser(context);
    return authorization(await authorizationFields(context, { prompt: 'consent' }), cookieHeaders(browser.cookies));
  } },
  'authorize-unknown-client': { request: async (context) => authorization(await authorizationFields(context, { client_id: 'unregistered-client' })) },
  'authorize-unregistered-redirect': { request: async (context) => authorization(await authorizationFields(context, { redirect_uri: OTHER_CALLBACK })) },
  'authorize-missing-scope': { async request(context) {
    const fields = await authorizationFields(context);
    fields.delete('scope');
    return authorization(fields);
  } },
  'par-push-code-pkce': { request: pushedRequest },
  'par-invalid-client': { request: (context) => pushedRequest(context, { invalidSecret: true }) },
  'par-invalid-redirect': { request: (context) => pushedRequest(context, { redirectUri: OTHER_CALLBACK }) },
  'register-public-code-client': { request: () => register() },
  'register-confidential-client': { request: () => register({ token_endpoint_auth_method: 'client_secret_basic' }) },
  'register-request-object-client': { async request(context) {
    const { registration } = await generateRequestScenario('authorize-request-object', { issuer: context.issuer });
    return register({ jwks: registration.jwks, request_object_signing_alg: registration.request_object_signing_alg });
  } },
  'register-invalid-redirect': { request: () => register({ redirect_uris: ['/callback'] }) },
  'register-invalid-metadata': { request: () => register({ grant_types: ['unsupported-grant'] }) },
};
