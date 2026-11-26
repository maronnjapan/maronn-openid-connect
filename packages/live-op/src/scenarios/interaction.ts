/**
 * The recipes of the cases of the OP's metadata and of its pages: the
 * login and the consent pages a browser goes through after an
 * authorization request, the Google sign-in callback, and RP-Initiated
 * Logout, on the live OP.
 */
import type { LiveRequest } from '../api.js';
import { headerOf } from '../grant.js';
import type { ScenarioContext, ScenarioRecipe } from '../scenario-runtime.js';
import { RP_CALLBACK, RP_LOGOUT } from '../seed.js';
import { beginLogin, clientForm, consentedBrowser, FORM_TYPE, get, jsonField, randomValue, requireStatus, signedInBrowser, type CaseBrowser, type QueryChanges } from './steps.js';

/** The client of the code flow the cases send as. */
const CODE_CLIENT = 'client-1';

/** The client registered for the implicit and hybrid flows. */
const FRONT_CHANNEL_CLIENT = 'implicit-client';

/** A browser that started an authorization and opened its login page: the request that submits the login form, with the changes given. */
async function submitCredentials(context: ScenarioContext, changes: Record<string, string> = {}): Promise<{ browser: CaseBrowser; request: LiveRequest }> {
  const { browser, login } = await beginLogin(context);
  return { browser, request: await browser.submitPage(login, changes, 'ログイン画面') };
}

/** A browser that signed in for an authorization (of client-1, or of the client and the changes given): the request that submits its consent page with the decision given. */
async function consentRequest(context: ScenarioContext, decision: string, clientId = CODE_CLIENT, changes: QueryChanges = {}): Promise<LiveRequest> {
  const { browser, consent } = await signedInBrowser(context, clientId, changes);
  return browser.submitPage(consent, { action: decision }, '同意画面');
}

/** A browser signed in and consented for client-1, and the ID Token the client got for the user by exchanging the code (OIDC Core 1.0 §3.1.3). */
async function idTokenForLogout(context: ScenarioContext): Promise<{ browser: CaseBrowser; idToken: string }> {
  const { browser, approved, codeVerifier } = await consentedBrowser(context);
  const code = new URL(headerOf(approved, 'location') ?? '', context.issuer).searchParams.get('code');
  if (code === null) throw new Error('同意の応答に認可コードがありません。');
  const exchanged = requireStatus(await context.send(clientForm(context, '/token', CODE_CLIENT, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: RP_CALLBACK,
    code_verifier: codeVerifier,
  })), 200, 'ID トークンの取得');
  return { browser, idToken: jsonField(exchanged, 'id_token') };
}

export const interactionRecipes: Record<string, ScenarioRecipe> = {
  'discovery-provider-metadata': { request: () => get('/.well-known/openid-configuration', [['accept', 'application/json']]) },
  'jwks-verify-signature': { request: () => get('/.well-known/jwks.json', [['accept', 'application/json']]) },
  'login-open-transaction': {
    async request(context) {
      const { browser, login } = await beginLogin(context);
      return browser.get(login);
    },
  },
  'login-without-transaction': { request: () => get('/login') },
  'login-submit-password': { request: async (context) => (await submitCredentials(context)).request },
  'login-retry-password': { request: async (context) => (await submitCredentials(context, { password: 'not-the-password' })).request },
  'login-expired-form': {
    // The CSRF token the OP put in the login form of another authorization, not the one of this form's transaction.
    async request(context) {
      const other = await beginLogin(context);
      const otherForm = await other.browser.submitPage(other.login, {}, '別のログイン画面');
      const otherToken = new URLSearchParams(otherForm.body).get('csrf_token');
      if (otherToken === null) throw new Error('別のログイン画面に csrf_token がありません。');
      return (await submitCredentials(context, { csrf_token: otherToken })).request;
    },
  },
  'login-attempts-exhausted': {
    async request(context) {
      const { browser, request } = await submitCredentials(context, { password: 'not-the-password' });
      for (let attempt = 0; attempt < 4; attempt += 1) await browser.send(request, 200, `${attempt + 1} 回目の誤ったログイン`);
      return request;
    },
  },
  'login-google-complete': {
    // External: the placeholders are the values a browser gets from Google Identity Services on an OP configured with a Google client.
    request: () => ({
      method: 'POST',
      path: '/login/google',
      headers: [FORM_TYPE, ['cookie', 'g_csrf_token={google_csrf_token}']],
      body: new URLSearchParams({ credential: '{google_id_token}', g_csrf_token: '{google_csrf_token}' }).toString(),
    }),
  },
  'login-google-disabled': { request: () => ({ method: 'POST', path: '/login/google', headers: [FORM_TYPE], body: '' }) },
  'consent-open': {
    async request(context) {
      const { browser, consent } = await signedInBrowser(context);
      return browser.get(consent);
    },
  },
  'consent-without-transaction': { request: () => get('/consent') },
  'consent-approve-code': { request: (context) => consentRequest(context, 'approve') },
  'consent-deny': { request: (context) => consentRequest(context, 'deny') },
  'consent-require-decision': { request: (context) => consentRequest(context, '') },
  'consent-require-login': {
    // The browser started the authorization and was sent to the login page, but posts the consent form of the transaction without signing in.
    async request(context) {
      const { browser, login } = await beginLogin(context);
      return browser.submitPage(`/consent${new URL(login, context.issuer).search}`, {}, '同意画面');
    },
  },
  'consent-approve-form-post': { request: (context) => consentRequest(context, 'approve', CODE_CLIENT, { response_mode: 'form_post' }) },
  'consent-approve-jarm': { request: (context) => consentRequest(context, 'approve', CODE_CLIENT, { response_mode: 'query.jwt' }) },
  'consent-approve-implicit': {
    request: (context) => consentRequest(context, 'approve', FRONT_CHANNEL_CLIENT, { response_type: 'id_token', code_challenge: undefined, code_challenge_method: undefined }),
  },
  'consent-approve-hybrid': { request: (context) => consentRequest(context, 'approve', FRONT_CHANNEL_CLIENT, { response_type: 'code id_token' }) },
  'logout-show-confirmation': {
    async request(context) {
      const { browser } = await signedInBrowser(context);
      return browser.get('/logout');
    },
  },
  'logout-confirm': {
    async request(context) {
      const { browser } = await signedInBrowser(context);
      return browser.submitPage('/logout', {}, 'ログアウト確認画面');
    },
  },
  'logout-approval-expired': {
    // No confirmation page was opened, so the browser has no confirmation to approve.
    async request(context) {
      const { browser } = await signedInBrowser(context);
      return browser.post('/logout/approve', []);
    },
  },
  'logout-use-id-token-hint': {
    async request(context) {
      const { browser, idToken } = await idTokenForLogout(context);
      return browser.post('/logout', { id_token_hint: idToken });
    },
  },
  'logout-registered-redirect': {
    async request(context) {
      const { browser, idToken } = await idTokenForLogout(context);
      return browser.get(`/logout?${new URLSearchParams({ id_token_hint: idToken, post_logout_redirect_uri: RP_LOGOUT, state: randomValue() })}`);
    },
  },
};
