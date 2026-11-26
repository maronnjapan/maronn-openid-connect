/**
 * What the map's E2E specs read on the page, as a reader finds it: the
 * flow of an endpoint, its request panel and the response, the line that
 * says how the replay follows the request (sent, opened or previewed), the playback and the flowchart
 * of the frame it shows, the recent requests of the workspace; and the
 * workspace the page uses, for the requests a spec sends outside the page.
 * The specs assert what these give.
 */
import { LIVE_PREFIX, WORKSPACE_COOKIE, WORKSPACE_HEADER, type ExchangeSummary } from '@maronn-openid-connect/live-op/api';
import type { APIRequestContext, BrowserContext, Locator, Page } from '@playwright/test';

export { EXCHANGE_HEADER, WORKSPACE_HEADER } from '@maronn-openid-connect/live-op/api';

/** The name of a flowchart node the request passed: before the scene shown, the scene shown, or where the scene ends (FlowChart.tsx STATE_WORDS). */
export const PASSED = /。(このリクエストが通った|いまの場所|この場面で終わる所)(。|$)/;

/** The name of a flowchart node the request passes after the scene shown. */
export const AHEAD = /。このリクエストがこの先で通る(。|$)/;

/** The name of a flowchart node the request does not pass. */
export const NOT_TAKEN = /。このリクエストは通らない(。|$)/;

/** A user of the OP's settings (packages/live-op seed.ts). */
export const USER = { username: 'testuser', password: 'password' };

/** The confidential client of the live OP that authenticates with HTTP Basic (seed.ts), and the path of the OP's own callback page, one of its redirect URIs. */
export const CLIENT = { id: 'client-1', callbackPath: `${LIVE_PREFIX}callback` };

/** The PKCE pair of RFC 7636 Appendix B. */
export const PKCE = { verifier: 'dBjftJeZ4CVP-mJ0kjQ1ZR8IdPz5NgHZQsy6W7GA0Q', challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' };

/** Escape a text for a regular expression. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Open the flow of an endpoint of the Hono OP as a playback (`#hono--<endpoint>;p`), with more options of the hash (`;x=x3`). */
export async function openFlow(page: Page, endpoint: string, more = ''): Promise<void> {
  await page.goto(`/#hono--${endpoint};p${more}`);
}

/** The select of the cases of the endpoint shown (想定リクエスト). */
export function caseSelect(page: Page): Locator {
  return page.getByRole('combobox', { name: '想定リクエスト' });
}

/** The panel of the request of the flow: the form, the response and the recent requests. */
export function requestPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'リクエスト', exact: true });
}

/** The form of the request to run on the live OP. */
export function requestForm(page: Page): Locator {
  return page.getByRole('form', { name: '実行するリクエスト' });
}

/** The value box of a row of the request form, by the row's name (`password`, `csrf_token`). */
export function formValue(page: Page, name: string): Locator {
  return requestForm(page).getByRole('textbox', { name: `${name}の値`, exact: true });
}

/** The button that sends the request of the form. */
export function runButton(page: Page): Locator {
  return requestForm(page).getByRole('button', { name: '▶ このリクエストを実行' });
}

/** The line of the response the OP gave (`応答 302 Found`). */
export function responseLine(page: Page): Locator {
  return requestPanel(page).getByRole('paragraph').filter({ has: page.getByText('応答', { exact: true }) });
}

/** The line that names the request shown: sent from the page (実行したリクエスト) or opened from the workspace (開いたリクエスト), with its id and how it came; none for a preview. */
export function exchangeLine(page: Page): Locator {
  return requestPanel(page).getByRole('paragraph').filter({ has: page.getByText(/^(実行した|開いた)リクエスト$/) });
}

/** The line that says the playback follows the way the request took, with the ending it reached. */
export function replayLine(page: Page): Locator {
  return requestPanel(page).getByText(/^このリクエストが通った道筋を再生しています/);
}

/** The line that names a preview of the request shown: run on a copy of the workspace's state, nothing sent (送る前の試算). */
export function previewLine(page: Page): Locator {
  return requestPanel(page).getByRole('paragraph').filter({ has: page.getByText('送る前の試算', { exact: true }) });
}

/** The line that says the playback follows the way a preview of the request shown would take, with the ending it reaches. */
export function previewReplayLine(page: Page): Locator {
  return requestPanel(page).getByText(/^このリクエストを送ると通る道筋を再生しています/);
}

/** The warning that the way replayed and what the request ran disagree (passes where it ran nothing, or skips a call or a side it took). */
export function mismatchWarning(page: Page): Locator {
  return page.getByRole('alert').filter({ hasText: '再生する道筋と、このリクエストが実際に動かしたコードが' });
}

/** The list of the recent requests of the workspace (最近のリクエスト). */
export function recentRequests(page: Page): Locator {
  return requestPanel(page).getByRole('group').filter({ hasText: /^最近のリクエスト/ });
}

/** The slider of the playback's position; End moves to the last scene and Home to the first. */
export function playbackPosition(page: Page): Locator {
  return page.getByRole('region', { name: 'フローの再生' }).getByRole('slider', { name: '再生の位置' });
}

/** The crumbs of the frames down to the one the diagram shows (`GET | POST /login` › `submitLogin()`). */
export function shownFrames(page: Page): Locator {
  return page.getByRole('navigation', { name: '図に出しているフレーム' });
}

/** A node of the flowchart of the frame shown, by its title (the start of its name, up to `。`). */
export function flowNode(page: Page, title: string): Locator {
  return page.getByRole('group', { name: 'リクエストの流れのフローチャート' }).getByRole('button', { name: new RegExp(`^${literal(title)}。`) });
}

/** The workspace of the map page of a browser context: the cookie the page sets for the OP's paths. */
export async function workspaceOf(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find((candidate) => candidate.name === WORKSPACE_COOKIE);
  if (cookie === undefined) throw new Error(`The map page set no ${WORKSPACE_COOKIE} cookie`);
  return cookie.value;
}

/** The ids of the exchanges a workspace recorded, oldest first (`GET /__live/exchanges`). */
export async function exchangeIds(request: APIRequestContext, workspace: string): Promise<string[]> {
  const response = await request.get(`${LIVE_PREFIX}exchanges`, { headers: { [WORKSPACE_HEADER]: workspace } });
  if (!response.ok()) throw new Error(`GET ${LIVE_PREFIX}exchanges answered ${response.status()}`);
  return ((await response.json()) as ExchangeSummary[]).map((exchange) => exchange.id);
}

/** The Authorization header of HTTP Basic for a client (RFC 6749 §2.3.1). */
export function basicAuthorization(clientId: string, secret: string): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString('base64')}`;
}

/** The URL of an authorization request of the confidential client that comes back to the OP's own callback page. */
export function authorizationUrl(baseURL: string): string {
  const url = new URL('/authorize', baseURL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT.id,
    redirect_uri: new URL(CLIENT.callbackPath, baseURL).href,
    scope: 'openid',
    state: 'e2e-state',
    nonce: 'e2e-nonce',
    code_challenge: PKCE.challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.href;
}
